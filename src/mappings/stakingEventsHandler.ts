import { Collator, DelegatorHistoryElement, Delegation, Round, Delegator, CollatorRound } from '../types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import { blockNumber, eventId, calculateFeeAsString, timestamp } from "./common";
enum eventTypes {
    Stake = 0,
    Unstake = 1,
    Reward = 2,
    Delegate = 3
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
    logger.debug(`Handling ${event.event.method} event`);
    switch (event.event.method) {
        case "Delegation": {
            const { event: { data: [delegator, amount, collator] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Delegate
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString()

            const delegation = new Delegation(eventId(event))
            delegation.roundId = round.id;
            delegation.collatorId = collator.toString();
            delegation.delegatorId = delegator.toString();

            records.push(delegation)
            break

        }
        case "DelegationIncreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Stake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString()
            break
        }
        case "DelegationDecreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Unstake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString()
            break
        }
        case "DelegationRevoked": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString()
            record.type = eventTypes.Unstake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString()
            break
        }

        case "Rewarded": {
            const { event: { data: [account, amount] } } = event;
            if (delegatorRoundList.find(element => element == account.toString())) {
                logger.debug(`Rewarded event is emitted to delegator: ${account.toString()}`);
                record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
                record.delegatorId = account.toString()
                record.type = eventTypes.Stake
                record.amount = parseFloat(amount.toString());
            }
            else if (collatorRoundList.find(element => element == account.toString())) {
                logger.debug(`Rewarded event is emitted to collator: ${account.toString()}`);
                let collatorRound = await CollatorRound.get(account.toString() + "-" + round.id);
                collatorRound.rewardAmount = parseFloat(amount.toString());
                await collatorRound.save();
            }
            else {
                logger.debug("Delegator/Collator not found in map")
            }
            break
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
    logger.debug(`Successfully handled an event. Saved ${records.length} records`);
}

async function handleNewRoundEntities(round: string): Promise<void> {
    delegatorRoundList = [];
    collatorRoundList = [];
    logger.debug("Cleared delegator and colators lists");
    const handleCandidateInfo = async () => {
        let candidateInfo = await api.query.parachainStaking.candidateInfo.entries();
        logger.debug("Got candidate info")
        let candidateInfoCollatorList = Array<string>();
        candidateInfo.forEach(async ([{ args: [collatorId] }, data]) => {
            const handleCollator = async () => {
                let collator = await Collator.get(collatorId.toString());
                candidateInfoCollatorList.push(collatorId.toString());
                if (collator === undefined) {
                    logger.debug(`Collator not found, creating new collator`);
                    collator = new Collator(collatorId.toString());
                }
                await collator.save();
            }
            const handleCollatorRound = async (round: string) => {
                let collatorRound = new CollatorRound(collatorId.toString() + "-" + round);
                logger.debug("Created collator round")
                collatorRound.ownBond = parseFloat(data.toHuman()['bond'].toString().replace(/,/g, ''));
                collatorRound.totalBond = parseFloat(data.toHuman()['totalCounted'].toString().replace(/,/g, ''));

                logger.debug(`collatorRound.ownBond / collatorRound.totalBond =  ${collatorRound.totalBond / collatorRound.ownBond}`);

                collatorRound.collatorId = collatorId.toString();
                collatorRound.roundId = round;

                // APR calculation
                const previousCollatorRound = await CollatorRound.get(collatorId.toString() + "-" + (parseInt(round) - 1));
                if (previousCollatorRound !== undefined) {
                    // collator stake share = collator’s stake / total stake
                    // amount_due = collator’s reward in last round / (0.2 + 0.5 * collator stake share)
                    // collator reward = (0.2*amount_due)+(0.5*amount_due*stake)
                    // annual collator reward = collator reward * 4 * 365
                    // APR for collator = annual collator reward / (total stake - delegators stake)

                    logger.debug(`Collator: ${collatorId}`);
                    let collatorStakeShare = collatorRound.ownBond / collatorRound.totalBond
                    logger.debug(`Collator stake share: ${collatorStakeShare}`);
                    let amountDue = previousCollatorRound.rewardAmount / (0.2 + 0.5 * collatorRound.ownBond)
                    logger.debug(`Amount due: ${amountDue}`);
                    let collatorReward = (0.2 * amountDue) + (0.5 * amountDue * collatorRound.ownBond)
                    logger.debug(`Collator reward: ${collatorReward}`);
                    let annualCollatorReward = collatorReward * 4 * 365
                    logger.debug(`Annual collator reward: ${annualCollatorReward}`);
                    collatorRound.apr = annualCollatorReward / collatorRound.ownBond
                    logger.debug(`Collator APR: ${collatorRound.apr}`);
                    // Need the field for the corresponding aggregation based on formula [period] APR = ∑ ([Own bondn / Total bondn ] * APRn ) / ∑ [Own bondn / Total bondn ]
                    collatorRound.aprTechnNumerator = collatorRound.ownBond / collatorRound.totalBond * collatorRound.apr
                    collatorRound.aprTechnDenominator = collatorRound.ownBond / collatorRound.totalBond
                    logger.debug(`Calculated technical APR fields`)
                }
                else {
                    logger.debug("No data for previous round. Cannot calculate APR for the current one")
                }
                await collatorRound.save();
            }
            await Promise.all([handleCollator(), handleCollatorRound(round)]);
        });
    }
    const handleAtStake = async () => {
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
    }

    await Promise.all([handleCandidateInfo(), handleAtStake()]);
};

async function handleRound(): Promise<Round> {
    let currentRound = (await api.query.parachainStaking.round())["current"].toString();
    let round = await Round.get(currentRound);
    if (round === undefined) {
        round = new Round(currentRound);
        logger.debug(`Round not found, creating new round: ${round.id}`);
        await round.save();
        await handleNewRoundEntities(round.id);
    }
    return round;
}

export async function stakingEventsHandler(event: SubstrateEvent): Promise<void> {
    const round = await handleRound();
    await populateDB(event, round);
};

