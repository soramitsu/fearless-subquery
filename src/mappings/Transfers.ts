import { Codec } from "@polkadot/types/types";
import { HistoryElement } from "../types";
import { SubstrateEvent } from "@subql/types";
import {
  blockNumber,
  eventId,
  calculateFeeAsString,
  timestamp,
} from "./common";

type TransferPayload = {
  event: SubstrateEvent;
  address: Codec;
  from: Codec;
  to: Codec;
  amount: Codec;
  suffix: string;
  assetId?: string;
};

export async function handleTokenTransfer(
  event: SubstrateEvent
): Promise<void> {
  const {event: { data: [currencyId, from, to, amount] } } = event;

  await createTransfer({
    event,
    address: from,
    from,
    to,
    suffix: "-from",
    amount,
    assetId: currencyId.toHex().toString(),
  });
  await createTransfer({
    event,
    address: to,
    from,
    to,
    suffix: "-to",
    amount,
    assetId: currencyId.toHex().toString(),
  });
}

async function createTransfer({
  event,
  address,
  suffix,
  from,
  to,
  amount,
  assetId = null,
}: TransferPayload) {
  const element = new HistoryElement(`${eventId(event)}${suffix}`);
  element.address = address.toString();
  element.timestamp = timestamp(event.block);
  element.blockNumber = blockNumber(event);
  if (event.extrinsic !== undefined) {
    element.extrinsicHash = event.extrinsic.extrinsic.hash.toString();
    element.extrinsicIdx = event.extrinsic.idx;
  }

  element.transfer = {
    assetId,
    amount: amount.toString(),
    from: from.toString(),
    to: to.toString(),
    fee: calculateFeeAsString(event.extrinsic),
    eventIdx: event.idx,
    success: true,
  };

  await element.save();
}