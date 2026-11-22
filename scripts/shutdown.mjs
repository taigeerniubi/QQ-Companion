/** Authenticate with the environment password, then stop the local service. */
export async function shutdownService(base,password,fetcher=fetch){
 if(typeof password!=='string'||!password.trim())throw new Error('Set the admin password in .env or .env.local before stopping the service.');
 const headers={'content-type':'application/json','x-companion-admin':'1',origin:base};
 const login=await fetcher(base+'/qq-companion/api/login',{method:'POST',headers,body:JSON.stringify({password}),signal:AbortSignal.timeout(10000)});
 if(!login.ok)throw new Error(`Login rejected: HTTP ${login.status}`);
 const cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie?.startsWith('qq_session='))throw new Error('Login did not return a session');
 const response=await fetcher(base+'/qq-companion/api/shutdown',{method:'POST',headers:{...headers,cookie},body:'{}',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error(`Stop rejected: HTTP ${response.status}`);
}
