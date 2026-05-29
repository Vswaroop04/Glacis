import { isValidContainerNumber } from "../src/enrich/container.js";
import { carrierFromScac } from "../src/enrich/carriers.js";

// CSQU3054383 is the canonical valid ISO 6346 example (check digit 3)
console.log(`CSQU3054383 valid: ${isValidContainerNumber("CSQU3054383")} (want true)`);
console.log(`CSQU3054384 valid: ${isValidContainerNumber("CSQU3054384")} (want false, tampered check digit)`);
console.log(`garbage valid: ${isValidContainerNumber("NOTACONTAINER")} (want false)`);
console.log(`SCAC MAEU -> ${carrierFromScac("MAEU")} (want Maersk)`);
console.log(`SCAC ONEY -> ${carrierFromScac("ONEY")}`);
console.log(`SCAC ZZZZ -> ${carrierFromScac("ZZZZ")} (want null)`);
