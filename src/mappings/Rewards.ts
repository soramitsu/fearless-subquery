import {AccumulatedReward, ErrorEvent, HistoryElement, Reward} from '../types';
import {SubstrateBlock, SubstrateEvent, SubstrateExtrinsic} from "@subql/types";
import {
    callsFromBatch,
    eventIdFromBlockAndIdx,
    isBatch,
    timestamp,
    eventId,
    isProxy,
    callFromProxy
} from "./common";
import {CallBase} from "@polkadot/types/types/calls";
import {AnyTuple} from "@polkadot/types/types/codec";
import {EraIndex, RewardDestination} from "@polkadot/types/interfaces/staking"
import {Balance} from "@polkadot/types/interfaces";
import {handleSlashForAnalytics} from "./StakeChanged"
import {cachedRewardDestination, cachedController} from "./Cache"

function isPayoutStakers(call: CallBase<AnyTuple>): boolean {
    return call.method == "payoutStakers"
}

function isPayoutValidator(call: CallBase<AnyTuple>): boolean {
    return call.method == "payoutValidator"
}

function extractArgsFromPayoutStakers(call: CallBase<AnyTuple>): [string, number] {
    const [validatorAddressRaw, eraRaw] = call.args

    return [validatorAddressRaw.toString(), (eraRaw as EraIndex).toNumber()]
}

function extractArgsFromPayoutValidator(call: CallBase<AnyTuple>, sender: string): [string, number] {
    const [eraRaw] = call.args

    return [sender, (eraRaw as EraIndex).toNumber()]
}

function determinePayoutCallsArgs(causeCall: CallBase<AnyTuple>, sender: string) : [string, number][] {
    if (isPayoutStakers(causeCall)) {
        return [extractArgsFromPayoutStakers(causeCall)]
    } else if (isPayoutValidator(causeCall)) {
        return [extractArgsFromPayoutValidator(causeCall, sender)]
    } else if (isBatch(causeCall)) {
        return callsFromBatch(causeCall)
            .map(call => {
                return determinePayoutCallsArgs(call, sender)
                    .map((value, index, array) => {
                        return value
                    })
            })
            .flat()
    } else if (isProxy(causeCall)) {
        let proxyCall = callFromProxy(causeCall)
        return determinePayoutCallsArgs(proxyCall, sender)
    } else {
        return []
    }
}

export async function handleSlashed(slashEvent: SubstrateEvent): Promise<void> {
    await handleSlash(slashEvent)
}

export async function handleSlash(slashEvent: SubstrateEvent): Promise<void> {
    await handleSlashForAnalytics(slashEvent)
    //await handleSlashForTxHistory(slashEvent)
    await updateAccumulatedReward(slashEvent, false)
    // let slashEventId = eventId(slashEvent)
    // try {
    //     let errorOccursOnEvent = await ErrorEvent.get(slashEventId)
    //     if (errorOccursOnEvent !== undefined) {
    //         logger.info(`Skip slashEvent: ${slashEventId}`)
    //         return;
    //     }

    //     await handleSlashForAnalytics(slashEvent)
    //     await handleSlashForTxHistory(slashEvent)
    //     await updateAccumulatedReward(slashEvent, false)
    // } catch (error) {
    //     logger.error(`Got error on slash event: ${slashEventId}: ${error.toString()}`)
    //     let saveError = new ErrorEvent(slashEventId)
    //     saveError.description = error.toString()
    //     await saveError.save()
    // }
}

async function handleSlashForTxHistory(slashEvent: SubstrateEvent): Promise<void> {
    let element = await HistoryElement.get(eventId(slashEvent))

    if (element !== undefined) {
        // already processed reward previously
        return;
    }

    const currentEra = (await api.query.staking.currentEra()).unwrap()
    const slashDeferDuration = api.consts.staking.slashDeferDuration

    const slashEra = slashDeferDuration == undefined
    ? currentEra.toNumber()
    : currentEra.toNumber() - slashDeferDuration.toNumber()

    const eraStakersInSlashEra = await api.query.staking.erasStakersClipped.entries(slashEra);
    const validatorsInSlashEra = eraStakersInSlashEra.map(([key, exposure]) => {
        let [, validatorId] = key.args

        return validatorId.toString()
    })
    const validatorsSet = new Set(validatorsInSlashEra)

    const initialValidator: string = ""

    await buildRewardEvents(
        slashEvent.block,
        slashEvent.extrinsic,
        slashEvent.event.method,
        slashEvent.event.section,
        {},
        initialValidator,
        (currentValidator, eventAccount) => {
            return validatorsSet.has(eventAccount) ? eventAccount : currentValidator
        },
        (validator, eventIdx, stash, amount) => {

            return {
                eventIdx: eventIdx,
                amount: amount,
                isReward: false,
                stash: stash,
                validator: validator,
                era: slashEra
            }
        }
    )
}

async function buildRewardEvents<A>(
    block: SubstrateBlock,
    extrinsic: SubstrateExtrinsic | undefined,
    eventMethod: String,
    eventSection: String,
    accountsMapping: {[address: string]: string},
    initialInnerAccumulator: A,
    produceNewAccumulator: (currentAccumulator: A, eventAccount: string) => A,
    produceReward: (currentAccumulator: A, eventIdx: number, stash: string, amount: string) => Reward
) {
    let blockNumber = block.block.header.number.toString()
    let blockTimestamp = timestamp(block)

    const [, savingPromises] = block.events.reduce<[A, Promise<void>[]]>(
        (accumulator, eventRecord, eventIndex) => {
            let [innerAccumulator, currentPromises] = accumulator

            if (!(eventRecord.event.method == eventMethod && eventRecord.event.section == eventSection)) return accumulator

            let {event: {data: [account, amount]}} = eventRecord

            const newAccumulator = produceNewAccumulator(innerAccumulator, account.toString())

            const eventId = eventIdFromBlockAndIdx(blockNumber, eventIndex.toString())

            const element = new HistoryElement(eventId);

            element.timestamp = blockTimestamp

            const accountAddress = account.toString()
            const destinationAddress = accountsMapping[accountAddress]
            element.address = destinationAddress != undefined ? destinationAddress : accountAddress

            element.blockNumber = block.block.header.number.toNumber()
            if (extrinsic !== undefined) {
                element.extrinsicHash = extrinsic.extrinsic.hash.toString()
                element.extrinsicIdx = extrinsic.idx
            }
            element.reward = produceReward(newAccumulator, eventIndex, accountAddress, amount.toString())

            currentPromises.push(element.save())

            return [newAccumulator, currentPromises];
        }, [initialInnerAccumulator, []])

    await Promise.allSettled(savingPromises);
}

async function updateAccumulatedReward(event: SubstrateEvent, isReward: boolean): Promise<void> {
    let {event: {data: [accountId, amount]}} = event
    let accountAddress = accountId.toString()

    let accumulatedReward = await AccumulatedReward.get(accountAddress);
    if (!accumulatedReward) {
        accumulatedReward = new AccumulatedReward(accountAddress);
        accumulatedReward.amount = BigInt(0)
    }
    const newAmount = (amount as Balance).toBigInt()
    accumulatedReward.amount = accumulatedReward.amount + (isReward ? newAmount : -newAmount)
    await accumulatedReward.save()
}
