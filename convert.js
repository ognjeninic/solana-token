const bs58 = (require('bs58').default || require('bs58'));

// 1. Paste your [numbers, in, the, array] here
const array = [214,24,61,159,203,79,101,130,235,46,72,203,47,23,50,85,101,34,177,47,89,152,86,136,100,175,227,145,66,169,86,141,201,156,72,162,227,160,112,153,200,50,190,146,18,161,184,231,58,104,226,225,93,85,5,146,71,9,126,39,40,170,69,132]; 

// 2. Run the conversion
console.log("Your Base58 Private Key:");
console.log(bs58.encode(Uint8Array.from(array)));