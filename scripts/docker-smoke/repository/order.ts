export function queueOrder(order: { id: string }) {
  return { ...order, status: "queued" };
}
