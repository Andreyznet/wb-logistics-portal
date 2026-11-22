class NotificationAudioPlayer {
 constructor(){this.context=null;this.buffers=new Map();this.source=null;this.gain=null;this.generation=0;this.loading=false;}
 async unlock(){if(!this.context||this.context.state==='closed')this.context=new (window.AudioContext||window.webkitAudioContext)();await this.context.resume();}
 prime(){
  const resumed=this.unlock();
  // A one-frame zero buffer warms up the audio path during the login gesture.
  // It is silent and is never a test alarm or an acknowledgement of a real alert.
  try{const source=this.context.createBufferSource();source.buffer=this.context.createBuffer(1,1,22050);source.connect(this.context.destination);source.onended=()=>source.disconnect();source.start();}catch{}
  return resumed;
 }
 get ready(){return this.context?.state==='running';}
 stop(){this.generation++;this.loading=false;const source=this.source;this.source=null;try{source?.stop();}catch{}source?.disconnect();this.gain?.disconnect();this.gain=null;}
 async play(url,volume,{loop=false}={}){
  this.stop();const generation=this.generation;this.loading=true;
  try{
   await this.unlock();if(generation!==this.generation)return false;
   if(!this.buffers.has(url))this.buffers.set(url,fetch(url).then(response=>{if(!response.ok)throw new Error('Не удалось загрузить звук.');return response.arrayBuffer();}).then(bytes=>this.context.decodeAudioData(bytes)).catch(error=>{this.buffers.delete(url);throw error;}));
   const buffer=await this.buffers.get(url);if(generation!==this.generation)return false;
   const source=this.context.createBufferSource(),gain=this.context.createGain();source.buffer=buffer;source.loop=loop;gain.gain.value=Math.min(1,Math.max(.1,volume/100));source.connect(gain).connect(this.context.destination);this.source=source;this.gain=gain;this.loading=false;source.onended=()=>{if(this.source===source){this.source=null;gain.disconnect();source.disconnect();}};source.start();return true;
  }catch(error){if(generation!==this.generation)return false;this.loading=false;throw error;}
 }
}
