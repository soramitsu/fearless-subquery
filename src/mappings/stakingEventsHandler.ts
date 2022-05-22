import { Collator, DelegatorHistoryElement, Delegation, Round, Delegator, CollatorRound } from '../types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import { blockNumber, eventId, calculateFeeAsString, timestamp } from "./common";

enum eventTypes {
    Stake = 0,
    Unstake = 1,
    Reward = 2,
    Delegate = 3
};

async function getRound(): Promise<string> {
    return (await api.query.parachainStaking.round())["current"].toString();
};

let delegatorRoundList = new Array<string>();
let collatorRoundList = new Array<string>();

function createAndPartlyPopulateDelegatorHistoryElement(event: SubstrateEvent, round: Round): DelegatorHistoryElement {
    const record = new DelegatorHistoryElement(eventId(event))
    record.blockNumber = blockNumber(event);
    record.timestamp = timestamp(event.block);
    record.roundId = round.id;
    return record;
}

export async function populateDB(event: SubstrateEvent, round: Round): Promise<void> {
    logger.debug(`Handling a deletor event: ${event.idx}`);
    let records: (Delegation | DelegatorHistoryElement | CollatorRound)[] = [];
    let record: DelegatorHistoryElement;
    switch (event.event.method) {
        case "Delegation": {
            const { event: { data: [delegator, amount, collator] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Delegate
            record.amount = amount.toString();
            record.collatorId = collator.toString()

            const delegation = new Delegation(eventId(event))
            delegation.roundId = round.id;
            delegation.collatorId = collator.toString();
            delegation.delegatorId = delegator.toString();

            records.push(delegation)

        }
        case "DelegationIncreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Stake
            record.amount = amount.toString();
            record.collatorId = collator.toString()
        }
        case "DelegationDecreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Unstake
            record.amount = amount.toString();
            record.collatorId = collator.toString()
        }
        case "DelegationRevoked": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Unstake
            record.amount = amount.toString();
            record.collatorId = collator.toString()
        }

        case "Rewarded": {
            const { event: { data: [account, amount] } } = event;
            logger.warn(account.toHuman());
            if (delegatorRoundList.find(element => element == account.toString())) {
                logger.debug(`Rewarded event is emitted to delegator: ${account.toString()}`);
                record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
                record.delegatorId = account.toString()
                record.type = eventTypes.Stake
                record.amount = amount.toString();
            }
            else if (collatorRoundList.find(element => element == account.toString())) {
                logger.debug(`Rewarded event is emitted to collator: ${account.toString()}`);
                let collatorRound = await CollatorRound.get(account.toString() + "-" + round.id);
                collatorRound.rewardAmount = amount.toString();
                await collatorRound.save();
            }
            else {
                logger.debug("Delegator/Collator not found in map")
            }
        }
    }
    if (record != undefined) {
        let delegator = await Delegator.get(record.delegatorId);
        if (delegator === undefined) {
            logger.debug(`Delegator not found, creating new delegator`);
            delegator = new Delegator(record.delegatorId);
            await delegator.save();
        }
        records.push(record)
    }

    await Promise.all(records.map(record => record.save()));
}


export async function stakingEventsHandler(event: SubstrateEvent): Promise<void> {
    let currentRound = await getRound();
    let round = await Round.get(currentRound);
    if (round === undefined) {
        round = new Round(currentRound);
        logger.debug(`Round not found, creating new round: ${round.id}`);
        await round.save();
        await handleNewRound(round.id).then(_ => populateDB(event, round));
    }
    populateDB(event, round);
};

export async function handleNewRound(round: string): Promise<boolean> {
    logger.debug(`Handling new round: ${round}`);
    delegatorRoundList = [];
    collatorRoundList = [];
    logger.debug("Cleared delegator and colators lists");
    let candidateInfo = await api.query.parachainStaking.candidateInfo.entries();
    logger.debug("Got candidate info")
    let candidateInfoCollatorList = Array<string>();
    candidateInfo.forEach(async ([{ args: [collatorId] }, data]) => {
        let collator = await Collator.get(collatorId.toString());
        candidateInfoCollatorList.push(collatorId.toString());
        if (collator === undefined) {
            logger.debug(`Collator not found, creating new collator`);
            collator = new Collator(collatorId.toString());
        }
        await collator.save();
        let collatorRound = new CollatorRound(collatorId.toString() + "-" + round);
        logger.debug("Created collator round")
        collatorRound.ownBond = data.toHuman()['bond'];
        collatorRound.totalBond = data.toHuman()['totalCounted'];
        collatorRound.collatorId = collatorId.toString();
        collatorRound.roundId = round;
        await collatorRound.save();
    });
    logger.debug(`Totally ${candidateInfoCollatorList.length} returned from candidateInfo query`)
    let atStake = await api.query.parachainStaking.atStake.entries(round)
    logger.debug("Got atStake")
    atStake.forEach(([{ args: [, collatorId] }, data]) => {
        collatorRoundList.push(collatorId.toString());
        let collatorDelegatorList: Array<string> = data['delegations'].map(object => object["owner"].toString());
        logger.debug("Got collator delegations")
        collatorDelegatorList.forEach(delegatorId => {
            delegatorRoundList.push(delegatorId.toString());
        });
    });
    logger.debug(`Totally ${collatorRoundList.length} returned from atStake query`)
    return true;
};