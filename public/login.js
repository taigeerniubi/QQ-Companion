document.querySelector('#login-form').onsubmit=async event=>{
 event.preventDefault();const form=event.target,button=form.querySelector('button'),notice=document.querySelector('#notice');button.disabled=true;
 try{const response=await fetch('/qq-companion/api/login',{method:'POST',headers:{'content-type':'application/json','x-companion-admin':'1'},body:JSON.stringify({token:form.elements.token.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'登录失败');form.reset();location.replace('/qq-companion/');}
 catch(error){notice.textContent=error.message;notice.className='error';}finally{button.disabled=false;}
};
