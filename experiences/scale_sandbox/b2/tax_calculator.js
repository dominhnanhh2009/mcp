function computeTax(item) {\n  if (item.isTaxExempt === true) {\n    return 0;\n  }\n  let tax = item.price * 0.1;\n  return tax;
}
module.exports = { computeTax };