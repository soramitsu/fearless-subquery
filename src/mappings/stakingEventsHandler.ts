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
const paymentDelay = 2;

function createAndPartlyPopulateDelegatorHistoryElement(event: SubstrateEvent, round: Round): DelegatorHistoryElement {
    const record = new DelegatorHistoryElement(eventId(event))
    record.blockNumber = blockNumber(event);
    record.timestamp = timestamp(event.block);
    if (event.event.method == "Rewarded") {
        record.roundId = (parseInt(round.id) - paymentDelay).toString();
    }
    else {
        record.roundId = round.id;
    }
    return record;
}

async function checkIfCollatorExistsOtherwiseCreate(collatorId: string): Promise<Collator> {
    let collator = await Collator.get(collatorId.toString().toLowerCase());
    if (collator === undefined) {
        logger.debug(`Collator ${collatorId.toString().toLowerCase()} not found in DB, creating new collator`);
        collator = new Collator(collatorId.toString());
        logger.debug(`Collator created`)
    }
    await collator.save();
    // logger.debug(`Collator ${collatorId} saved to DB`);
    return collator;
}

async function checkIfCollatorRoundExistsOtherwiseCreate(collatorId: string, round: Round): Promise<CollatorRound> {
    let collatorRound = await CollatorRound.get(collatorId + "-" + round.id);
    if (collatorRound === undefined) {
        logger.debug(`CollatorRound ${collatorId} not found in DB, creating new collatorRound`);
        collatorRound = new CollatorRound(collatorId + "-" + round.id);
        collatorRound.collatorId = collatorId
        collatorRound.roundId = round.id
    }
    await collatorRound.save();
    return collatorRound;
}

async function checkIfRoundExistsOtherwiseCreate(roundId: string): Promise<Round> {
    let round = await Round.get(roundId);
    if (round === undefined) {
        logger.debug(`Round ${roundId} not found in DB, creating new Round`);
        round = new Round(roundId);
    }
    await round.save();
    return round;
}

async function calculateAPRForPreviousRound(collatorRoundDelayed: CollatorRound, collator: Collator, round: Round): Promise<void> {
    // As Rewarded event is being emmited after 2 rounds have passed, APR could be calculated for a previous round 

    logger.debug(`Calculating APR for previous round`);

    const previousCollatorRound = await CollatorRound.get(collator.id.toString().toLowerCase() + "-" + (parseInt(round.id) - 1).toString());

    // collator stake share = collator’s stake / total stake
    // amount_due = collator’s reward in last round / (0.2 + 0.5 * collator stake share)
    // collator reward = (0.2*amount_due)+(0.5*amount_due*stake)
    // annual collator reward = collator reward * 4 * 365
    // APR for collator = annual collator reward / (total stake - delegators stake)

    logger.debug(`Got previous round ${previousCollatorRound.id}`)
    logger.debug(`Collator: ${collator.id.toLowerCase()}`);
    // logger.debug(`Previous round rewardAmount: ${previousCollatorRound.rewardAmount.toString()}`);
    logger.debug(`Own bond: ${previousCollatorRound.ownBond}`);
    let collatorStakeShare = previousCollatorRound.ownBond / previousCollatorRound.totalBond
    logger.debug(`Collator stake share: ${collatorStakeShare}`);
    let amountDue = collatorRoundDelayed.rewardAmount / (0.2 + 0.5 * previousCollatorRound.ownBond)
    logger.debug(`Amount due: ${amountDue}`);
    let collatorReward = (0.2 * amountDue) + (0.5 * amountDue * previousCollatorRound.ownBond)
    logger.debug(`Collator reward: ${collatorReward}`);
    let annualCollatorReward = collatorReward * 4 * 365
    logger.debug(`Annual collator reward: ${annualCollatorReward}`);
    previousCollatorRound.apr = annualCollatorReward / previousCollatorRound.ownBond
    logger.debug(`Collator APR: ${previousCollatorRound.apr}`);
    // Need the field for the corresponding aggregation based on formula [period] APR = ∑ ([Own bondn / Total bondn ] * APRn ) / ∑ [Own bondn / Total bondn ]
    previousCollatorRound.aprTechnNumerator = previousCollatorRound.ownBond / previousCollatorRound.totalBond * previousCollatorRound.apr
    previousCollatorRound.aprTechnDenominator = previousCollatorRound.ownBond / previousCollatorRound.totalBond
    logger.debug(`Calculated technical APR fields`)

    await previousCollatorRound.save()

    // if (previousCollatorRound !== undefined && previousCollatorRound.rewardAmount !== null) {
    // }
    // else {
    //     logger.debug(`No data for previous round (Collator: ${collatorId.toString()} Round: ${round}) => Cannot calculate APR for the current one`)
    // }
}

async function calculateAPRFor24h(collatorRoundDelayed: CollatorRound, collator: Collator, round: Round) {
    // As Rewarded event is being emmited after 2 rounds have passed, APR could be calculated for a previous round
    logger.debug(`Calculating APR for previous 24h`);

    const previousCollatorRound = await CollatorRound.get(collator.id.toString().toLowerCase() + "-" + (parseInt(round.id) - 1).toString());
    const firstCollatorRoundDay = await CollatorRound.get(collator.id.toString().toLowerCase() + "-" + (parseInt(round.id) - 4).toString());
    const updated24hApr = 0
    logger.debug(`Collator first round: ${firstCollatorRoundDay}`);
    logger.debug(`Collator last round: ${previousCollatorRound}`);

    let last24hApr = 0
    if (firstCollatorRoundDay !== undefined) {
        if (collator.apr24h !== undefined || collator.apr24h !== 0) {
            let last24hApr = collator.apr24h;
        }
        logger.debug(`last24hApr: ${last24hApr}`);
        logger.debug(`lastRoundAprr: ${previousCollatorRound.apr}`);
        logger.debug(`firstRoundAprr: ${firstCollatorRoundDay.apr}`);
        let updated24hApr = last24hApr - firstCollatorRoundDay.apr + previousCollatorRound.apr;
        logger.debug(`last24hApr: ${updated24hApr}`);
    }
    else {
        let updated24hApr = 0;
    }
    collator.apr24h = updated24hApr;
    await collator.save();
}

export async function populateDB(event: SubstrateEvent, round: Round): Promise<void> {
    logger.debug(`Handling a delegator event: ${event.idx}`);
    let records: (Delegation | DelegatorHistoryElement | CollatorRound)[] = [];
    let record: DelegatorHistoryElement;
    logger.debug(`Handling ${event.event.method} event`);
    switch (event.event.method) {
        case "Delegation": {
            const { event: { data: [delegator, amount, collator] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString().toLowerCase()
            record.type = eventTypes.Delegate
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString().toLowerCase();
            logger.debug(`Collator exist ${record.collatorId} check`)
            await checkIfCollatorExistsOtherwiseCreate(record.collatorId.toString().toLowerCase());

            const delegation = new Delegation(eventId(event))
            delegation.roundId = round.id;
            delegation.collatorId = collator.toString().toLowerCase();
            delegation.delegatorId = delegator.toString().toLowerCase();

            records.push(delegation)
            break

        }
        case "DelegationIncreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString().toLowerCase()
            record.type = eventTypes.Stake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString().toLowerCase()
            break
        }
        case "DelegationDecreased": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString().toLowerCase()
            record.type = eventTypes.Unstake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString().toLowerCase()
            break
        }
        case "DelegationRevoked": {
            const { event: { data: [delegator, collator, amount] } } = event;
            record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
            record.delegatorId = delegator.toString().toLowerCase()
            record.type = eventTypes.Unstake
            record.amount = parseFloat(amount.toString());
            record.collatorId = collator.toString()
            break
        }

        case "Rewarded": {
            const { event: { data: [account, amount] } } = event;
            if (delegatorRoundList.find(element => element == account.toString().toLowerCase())) {
                logger.debug(`Rewarded event is emitted to delegator: ${account.toString().toLowerCase()}`);
                record = createAndPartlyPopulateDelegatorHistoryElement(event, round);
                record.delegatorId = account.toString().toLowerCase()
                record.type = eventTypes.Reward
                record.amount = parseFloat(amount.toString());
            }
            else if (collatorRoundList.find(element => element == account.toString().toLowerCase())) {
                logger.debug(`Rewarded event is emitted to collator: ${account.toString().toLowerCase()}`);
                logger.debug(`Checking if rewardRound exists in DB`);
                let rewardRound = await checkIfRoundExistsOtherwiseCreate((parseInt(round.id) - paymentDelay).toString());
                let collator = await checkIfCollatorExistsOtherwiseCreate(account.toString().toLowerCase());
                logger.debug(`Current round - ${round.id}, reward round - ${rewardRound.id}`);
                logger.debug(`Checking delayed round entity`);
                let collatorRoundDelayed = await checkIfCollatorRoundExistsOtherwiseCreate(collator.id.toLowerCase(), rewardRound);
                collatorRoundDelayed.rewardAmount = parseFloat(amount.toString());
                await collatorRoundDelayed.save();
                logger.debug(`Saved rewardAmount for delayed round ${collatorRoundDelayed.id}`);
                await calculateAPRForPreviousRound(collatorRoundDelayed, collator, round)
                //await calculateAPRFor24h(collatorRoundDelayed, collator, round)
            }
            else {
                logger.debug("Delegator/Collator not found in map")
            }
            break
        }
    }
    if (record != undefined) {
        let delegator = await Delegator.get(record.delegatorId.toLowerCase());
        if (delegator === undefined) {
            logger.debug(`Delegator ${record.delegatorId} not found in DB, creating new one`);
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
        logger.debug(`Got candidate info for round ${round}`)
        let candidateInfoCollatorList = Array<string>();
        candidateInfo.forEach(async ([{ args: [collatorId] }, data]) => {
            let collator = await checkIfCollatorExistsOtherwiseCreate(collatorId.toString())
            let collatorRound = new CollatorRound(collator.id.toLowerCase() + "-" + round);
            logger.debug(`Created collator-round entity. Collator: ${collator.id.toString().toLowerCase()} Round: ${round}`);
            collatorRound.ownBond = parseFloat(data.toHuman()['bond'].toString().replace(/,/g, ''));
            collatorRound.totalBond = parseFloat(data.toHuman()['totalCounted'].toString().replace(/,/g, ''));

            logger.debug(`collatorRound.ownBond / collatorRound.totalBond =  ${collatorRound.totalBond / collatorRound.ownBond}`);

            collatorRound.collatorId = collator.id.toLowerCase();
            collatorRound.roundId = round;
            await collatorRound.save();

            // logger.debug(`🚩 handleCollator and handleCollatorRound finished`);
        });
    }
    await handleCandidateInfo();
    logger.debug(`🚩 handleCandidateInfo finished`);
    const handleAtStake = async () => {
        let atStake = await api.query.parachainStaking.atStake.entries(round)
        atStake.forEach(([{ args: [, collatorId] }, data]) => {
            collatorRoundList.push(collatorId.toString());
            let collatorDelegatorList: Array<string> = data['delegations'].map(object => object["owner"].toString());
            logger.debug(`Got delegations of collator ${collatorId.toString()}`);
            collatorDelegatorList.forEach(delegatorId => {
                delegatorRoundList.push(delegatorId.toString());
            });
        });
    }
    await handleAtStake();
    // await Promise.all([handleCandidateInfo(), handleAtStake()]);
    // logger.debug(`🚩 handleCandidateInfo and handleAtStake finished`);
    logger.debug(`🚩 handleAtStake finished`);
    logger.debug(`🚩 handleCandidateInfo and handleAtStake finished`);
};

async function handleRound(): Promise<Round> {
    let currentRound = (await api.query.parachainStaking.round())["current"].toString();
    let round = await Round.get(currentRound);
    if (round === undefined) {
        round = new Round(currentRound);
        logger.debug(`Round not found, creating new round: ${round.id}`);
        await round.save();
        await handleNewRoundEntities(round.id);
        logger.debug(`🏁 Saved all entities for round: ${round.id}`);
    }
    else {
        logger.debug("Round already exists, skipping entities creation");
    }
    return round;
}

export async function stakingEventsHandler(event: SubstrateEvent): Promise<void> {
    logger.debug(`Event in block ${event.block.block.header.number.toNumber()}`);
    const round = await handleRound();
    await populateDB(event, round);
};

