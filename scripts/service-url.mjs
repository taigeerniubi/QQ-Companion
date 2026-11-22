import {isIP} from 'node:net';
export function managementBase(config){
 const bind=config.listenHost??'0.0.0.0';
 const host=bind==='0.0.0.0'||bind==='::'?'127.0.0.1':bind;
 return `http://${isIP(host)===6?`[${host}]`:host}:${config.port??3210}`;
}
