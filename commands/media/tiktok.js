/**
 * .tiktok - TikTok Search & Download
 * Fixed download resolver
 */

const axios=require("axios");
const {sendBtn,btn}=require("../../utils/sendBtn");

const BASE="https://tikwm.com";

const HEADERS={
 "User-Agent":"Mozilla/5.0 Chrome/120 Safari/537.36",
 "Accept":"*/*",
 "Referer":"https://www.tiktok.com/"
};

const pending=new Map();
const TTL=300000;


function save(j,v){
 pending.set(j,{v,t:Date.now()});
}

function load(j){
 let x=pending.get(j);
 if(!x)return null;
 if(Date.now()-x.t>TTL){
  pending.delete(j);
  return null;
 }
 return x.v;
}


function post(url,data){
 return axios.post(
  url,
  new URLSearchParams(data),
  {
   timeout:20000,
   headers:{
    ...HEADERS,
    "Content-Type":"application/x-www-form-urlencoded",
    Origin:"https://tikwm.com"
   }
  }
 );
}


async function buffer(url){
 let r=await axios.get(url,{
  responseType:"arraybuffer",
  timeout:90000,
  maxRedirects:20,
  headers:{
   ...HEADERS,
   Range:"bytes=0-"
  }
 });
 return Buffer.from(r.data);
}



async function search(q){

 let r=await post(
  BASE+"/api/feed/search",
  {
   keywords:q,
   count:"10",
   cursor:"0",
   HD:"1",
   web:"1"
  }
 );


 let v=r.data?.data?.videos;

 if(!v?.length)
  throw Error("No results");

 return v;
}



async function resolve(url){

 let r=await post(
  BASE+"/api/",
  {
   url:url,
   hd:"1"
  }
 );


 let d=r.data?.data;

 if(!d)
  throw Error("Resolve failed");


 let video=
 d.hdplay||
 d.play||
 d.wmplay;


 if(!video)
  throw Error("No video");


 return {
  url:video,
  title:d.title||"TikTok Video",
  author:d.author?.nickname||"Unknown",
  duration:d.duration||0
 };
}



async function sendVideo(sock,msg,from,react,reply,data){

 try{

 await react("⏳");

 let b=await buffer(data.url);


 await sock.sendMessage(
 from,
 {
  video:b,
  mimetype:"video/mp4",
  fileName:"tiktok.mp4",
  caption:
  `🎬 ${data.title}\n`+
  `👤 ${data.author}\n\n`+
  `> INFINITY MD`
 },
 {quoted:msg}
 );


 await react("✅");


 }catch(e){

 console.log("[TikTok]",e.message);

 await react("❌");

 reply("❌ Video download failed");

 }

}



module.exports={

name:"tiktok",

aliases:["tt","ttsearch"],

category:"media",

description:"TikTok search and download",


async execute(sock,msg,args,extra){

const {from,reply,react}=extra;

const sender=
msg.key.participant||
msg.key.remoteJid;


try{


if(args[0]=="pick"){

let vids=load(sender);

let i=parseInt(args[1]);

if(!vids||isNaN(i)||!vids[i])
return reply("❌ Search expired");


let result=
await resolve(
 vids[i].play||
 vids[i].url
);


return sendVideo(
sock,msg,from,react,reply,result
);

}



let q=args.join(" ").trim();


if(!q)
return reply(
"❌ Use .tiktok <search/url>"
);



if(q.includes("tiktok.com")){

let result=
await resolve(q);

return sendVideo(
sock,msg,from,react,reply,result
);

}



await react("⏳");


let vids=
(await search(q)).slice(0,5);


save(sender,vids);



let buttons=
vids.map((v,i)=>
btn(
"tiktok_pick_"+i,
`${i+1}. ${(v.title||"Video").slice(0,45)}`
)
);



await sendBtn(
sock,
from,
{
title:"🎵 TikTok Results",

text:
`🔍 ${q}\n\nChoose video:`,

footer:"♾ Infinity MD",

buttons

},
{quoted:msg}
);


await react("✅");



}catch(e){

console.log("[TikTok]",e.message);

await react("❌");

reply(
"❌ TikTok failed"
);

}


}

};
