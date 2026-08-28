import { VGMParser } from './vgm-parser';

const parser = VGMParser.fromFile('02 Departure.vgm');
const data = parser.parse();

const ch0notes: number[] = [], ch1notes: number[] = [];
const chs = [{f:0,v:15},{f:0,v:15},{f:0,v:15}];
let lastCh = 0;

for(const c of data.commands){
  if(c.type==='psg_write'){
    const d=c.data!;
    if((d&0x80)===0x80){
      const ch=(d>>5)&3, t=(d>>4)&1, n=d&0xF;
      lastCh=ch;
      if(t===0&&ch<3) chs[ch].f=(chs[ch].f&0x3F0)|n;
      else if(t===1&&ch<3) chs[ch].v=n;
    }else{
      const ch=lastCh;
      if(ch<3){
        chs[ch].f=((d&0x3F)<<4)|(chs[ch].f&0xF);
        if(chs[ch].v<0xF&&chs[ch].f>0){
          const hz=3579545/(32*chs[ch].f);
          const m=Math.round(69+12*Math.log2(hz/440));
          if(ch===0) ch0notes.push(m);
          if(ch===1) ch1notes.push(m);
        }
      }
    }
  }
}

const changes0 = ch0notes.filter((n,i)=>i===0||n!==ch0notes[i-1]).length;
const changes1 = ch1notes.filter((n,i)=>i===0||n!==ch1notes[i-1]).length;

console.log(`Channel 0: ${ch0notes.length} frequency updates, ${changes0} MIDI note changes`);
console.log(`Channel 1: ${ch1notes.length} frequency updates, ${changes1} MIDI note changes`);
console.log('');
console.log('Channel 0 note transitions (first 30):');
for(let i=0; i<Math.min(30, ch0notes.length); i++){
  if(i===0 || ch0notes[i]!==ch0notes[i-1]){
    console.log(`  Transition ${i}: MIDI ${ch0notes[i]}`);
  }
}
