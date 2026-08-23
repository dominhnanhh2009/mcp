function deductStock(stock, requestedQty) {
  if (stock.qty < requestedQty) {
    throw new Error('Out of stock');
  }
  stock.qty -= requestedQty;
  return stock.qty;
}
module.exports = { deductStock };