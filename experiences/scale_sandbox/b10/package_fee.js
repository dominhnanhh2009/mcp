function calculatePackaging(packageInfo) {
  let cost = 10000;
  if (packageInfo.isFragile === true) {
    cost += 20000;
  }
  return cost;
}
module.exports = { calculatePackaging };