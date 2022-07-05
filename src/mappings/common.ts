import { SubstrateBlock, SubstrateEvent } from "@subql/types";

export function eventId(event: SubstrateEvent): string {
    return `${blockNumber(event)}-${event.idx}`
}

export function eventIdFromBlockAndIdx(blockNumber: string, eventIdx: string) {
    return `${blockNumber}-${eventIdx}`
}

export function blockNumber(event: SubstrateEvent): number {
    return event.block.block.header.number.toNumber()
}

export function timestamp(block: SubstrateBlock): bigint {
    return BigInt(Math.round((block.timestamp.getTime() / 1000)))
}

