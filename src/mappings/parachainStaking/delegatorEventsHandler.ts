import { DelegatorsEvent } from '../../types';
import { SubstrateEvent, SubstrateBlock } from "@subql/types";
import { blockNumber, eventId, calculateFeeAsString, timestamp } from "../common";

interface IDelegatorsEvent {
    amount: string
    delegator: string,
    collator?: string,
    type: number
};

enum eventTypes {
    Stake = 0,
    Unstake = 1,
    Reward = 2,
    Delegate = 3
};

function getRound(event: SubstrateEvent): number {
    return Math.floor(blockNumber(event) / 1800)
};

function formatEvent(
    event: SubstrateEvent,
): IDelegatorsEvent {
    switch (event.event.method) {
        case "Delegation": {
            const { event: { data: [delegator, amount, collator] } } = event;
            return {
                amount: amount.toString(),
                delegator: delegator.toString(),
                collator: collator.toString(),
                type: eventTypes.Delegate,
            }
        }
        case "DelegationIncreased": {
            const { event: { data: [delegator, collator , amount] } } = event;
            return {
                amount: amount.toString(),
                delegator: delegator.toString(),
                collator: collator.toString(),
                type: eventTypes.Stake
            }
        }
        case "DelegationDecreased": {
            const { event: { data: [delegator, collator , amount] } } = event;
            return {
                amount: amount.toString(),
                delegator: delegator.toString(),
                collator: collator.toString(),
                type: eventTypes.Unstake
            }
        }
        case "DelegationRevoked": {
            const { event: { data: [delegator, collator , amount] } } = event;
            return {
                amount: amount.toString(),
                delegator: delegator.toString(),
                collator: collator.toString(),
                type: eventTypes.Unstake
            }
        }

        case "Rewarded": {
            const { event: { data: [delegator, amount] } } = event;
            return {
                amount: amount.toString(),
                delegator: delegator.toString(),
                type: eventTypes.Stake
            }
        }
    }
};

export async function delegatorEventsHandler(event: SubstrateEvent): Promise<void> {

    logger.info("Caught delegation related event")

    const record = new DelegatorsEvent(eventId(event));
    record.blockNumber = blockNumber(event);
    record.delegator = formatEvent(event).delegator
    record.timestamp = timestamp(event.block)
    record.type = formatEvent(event).type
    record.round = getRound(event)
    record.amount = formatEvent(event).amount

    const collator = formatEvent(event).collator;

    if (collator != null) {
        record.collator = collator
    }

    await record.save()

};