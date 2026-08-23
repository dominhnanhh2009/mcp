function getShippingFee(distanceKm, option) {
  let fee = distanceKm * 5000;
  if (option.isExpress === true) {
    fee = fee * 2; // Double the fee
    fee = fee + 15000; // Add insurance fee
  }
  return fee;
}
module.exports = { getShippingFee };