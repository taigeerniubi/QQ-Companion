import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {createHash} from 'node:crypto';import {type Duplex} from 'node:stream';
import {OneBot} from '../src/qq/onebot.ts';
test('real loopback WebSocket filters account identity and stops on mismatch',async()=>{
 let peer:Duplex|undefined;let handshake='';
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:100}}));});
 server.on('upgrade',(req,socket)=>{handshake=req.url??'';peer=socket;const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',data=>{if((data[0]!&15)===8)socket.end(Buffer.from([0x88,0]));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as any).port,received:any[]=[];const bot=new OneBot({httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,token:'test-token',selfId:'100'});
 const until=async(fn:()=>boolean)=>{for(let n=0;n<100&&!fn();n++)await new Promise(r=>setTimeout(r,10));assert(fn());};
 const send=(value:unknown)=>{const data=Buffer.from(JSON.stringify(value));assert(data.length<126);peer!.write(Buffer.concat([Buffer.from([0x81,data.length]),data]));};
 try{await bot.connect(e=>received.push(e));await until(()=>bot.status==='connected');assert(handshake.includes('access_token=test-token'));send({self_id:100,post_type:'message'});await until(()=>received.length===1);send({self_id:999,post_type:'message'});await until(()=>bot.status==='identity_mismatch');assert.equal(received.length,1);}finally{bot.close();peer?.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});
