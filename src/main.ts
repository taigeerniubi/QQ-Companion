import {startService} from './service.ts';
const args=process.argv.slice(2);let configPath:string|undefined;
if(args.length){if(args.length!==2||args[0]!=='--config')throw new Error('Usage: node dist/main.js [--config path]');configPath=args[1];}
try{
 const service=await startService({configPath});
 console.log(`QQ companion service: ${service.url}/qq-companion/`);
 console.log('Local-only. Admin token is read from QQ_ADMIN_TOKEN or data/admin-token. QQ stays disabled until configured.');
 const stop=()=>{void service.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);await service.closed;
}catch(e){console.error(e instanceof Error?e.message:'Service failed to start');process.exitCode=1;}
