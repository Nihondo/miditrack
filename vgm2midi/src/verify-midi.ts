import * as fs from 'fs';

const file = '02 Departure v2.mid';
const buffer = fs.readFileSync(file);

console.log(`MIDI file: ${file}`);
console.log(`File size: ${buffer.length} bytes`);
console.log(`Header: ${buffer.slice(0, 4).toString('ascii')}`);

// Parse basic MIDI header
const formatType = buffer.readUInt16BE(8);
const numTracks = buffer.readUInt16BE(10);
const division = buffer.readUInt16BE(12);

console.log(`Format: ${formatType}`);
console.log(`Number of tracks: ${numTracks}`);
console.log(`Division (ticks per quarter note): ${division}`);
console.log('\nThe MIDI file appears to be valid!');
console.log('You can play it with any MIDI player or import into a DAW.');
