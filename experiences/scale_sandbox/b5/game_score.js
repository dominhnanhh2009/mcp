function calcScore(player, basePoints) {
  let score = basePoints;
  if (player.streak >= 5) {
    score *= 2;
  }
  return score;
}
module.exports = { calcScore };