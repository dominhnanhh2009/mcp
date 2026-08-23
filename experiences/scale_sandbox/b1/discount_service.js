function calculateFinalPrice(order) {
  let itemsTotal = 0;
  for (const item of order.items) {
    itemsTotal += item.price * item.qty;
  }
  // VIP discount: 15% reduction
  if (order.customerType === 'VIP') {
    itemsTotal = itemsTotal * 0.85; // 85% of the original total
  }
  return itemsTotal;
}
module.exports = { calculateFinalPrice };