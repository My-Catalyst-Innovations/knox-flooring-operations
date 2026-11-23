import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({connection:null as any,nonceIds:new Set<string>(),failInsert:false,events:[] as string[],queue:Promise.resolve()}));
vi.mock("@workspace/db/workspace",()=>({workspaceEnvironment:()=>process.env,workspaceScopeKey:()=>"test"}));
vi.mock("@workspace/db",async()=>{
  const schema=await import("../../../../lib/db/src/schema/index");const {getTableName}=await import("drizzle-orm");
  const read=()=>({from:()=>({limit:async()=>mocks.connection?[structuredClone(mocks.connection)]:[],where:()=>({for:async()=>{mocks.events.push("row_lock");return mocks.connection?[structuredClone(mocks.connection)]:[];}})})});
  const db:any={select:read,execute:async()=>{mocks.events.push("company_lock");},delete:async()=>{mocks.connection=null;},update:()=>({set:(values:any)=>({where:()=>{Object.assign(mocks.connection,values);return {returning:async()=>[structuredClone(mocks.connection)],then:(resolve:any)=>Promise.resolve().then(resolve)};}})}),
    insert:(table:any)=>({values:(data:any)=>{
      if(getTableName(table)==="audit_events")return {onConflictDoNothing:()=>({returning:async()=>{if(mocks.nonceIds.has(data.id))return [];mocks.nonceIds.add(data.id);return [{id:data.id}];}})};
      if(mocks.failInsert)throw new Error("insert failed");mocks.connection=structuredClone(data);return Promise.resolve();
    }}),
  };
  db.transaction=async(fn:any)=>{const preceding=mocks.queue;let done!:()=>void;mocks.queue=new Promise<void>(resolve=>{done=resolve;});await preceding;const original=structuredClone(mocks.connection);try{return await fn(db);}catch(error){mocks.connection=original;throw error;}finally{done();}};
  return {...schema,db};
});
import {consumeQuickBooksOAuthState,createQuickBooksOAuthState,encryptSecret,qboRequest,quickBooksProjectReadiness,replaceQuickBooksConnection,requireQuickBooksProjects,validQuickBooksOAuthState} from "./quickbooks";

describe("QuickBooks connection safety",()=>{
  beforeEach(()=>{
    vi.stubEnv("QUICKBOOKS_ENCRYPTION_KEY","synthetic-key-at-least-thirty-two-characters");vi.stubEnv("QUICKBOOKS_CLIENT_ID","test");vi.stubEnv("QUICKBOOKS_CLIENT_SECRET","test");vi.stubEnv("DEMO_MODE","false");vi.stubEnv("QUICKBOOKS_ENVIRONMENT","production");
    mocks.connection={id:"connection-a",realmId:"123",environment:"sandbox",status:"connected",encryptedAccessToken:encryptSecret("expired"),encryptedRefreshToken:encryptSecret("refresh"),accessTokenExpiresAt:"2000-01-01T00:00:00Z"};
    mocks.nonceIds.clear();mocks.failInsert=false;mocks.events=[];mocks.queue=Promise.resolve();vi.stubGlobal("fetch",vi.fn());
  });
  afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
  it("rotates an expired token once across concurrent callers and uses the saved company's environment",async()=>{
    vi.mocked(fetch).mockImplementation(async(url,options)=>{
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if(String(url).includes("tokens/bearer"))return Response.json({access_token:"fresh",refresh_token:"rotated",expires_in:3600,x_refresh_token_expires_in:86400});
      expect(String(url)).toMatch(/^https:\/\/sandbox-quickbooks.api.intuit.com\/v3\/company\/123\//);return Response.json({ok:true});
    });
    await Promise.all([qboRequest("/companyinfo/123"),qboRequest("/companyinfo/123")]);
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).includes("tokens/bearer"))).toHaveLength(1);
    expect(mocks.events.filter(value=>value==="row_lock")).toHaveLength(2);
  });
  it("commits revocation but preserves authorization for a temporary token-service outage",async()=>{
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:429}));
    await expect(qboRequest("/companyinfo/123")).rejects.toMatchObject({status:429});expect(mocks.connection.status).toBe("connected");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:400}));
    await expect(qboRequest("/companyinfo/123")).rejects.toThrow(/reconnect/);expect(mocks.connection.status).toBe("reconnect_required");
  });
  it("binds OAuth to owner, session, expiry and one durable use",async()=>{
    const state=createQuickBooksOAuthState("owner","csrf",1000);
    expect(validQuickBooksOAuthState(state,"owner","csrf",1500)).toBe(true);
    for(const [user,csrf,time] of [["other","csrf",1500],["owner","other-session",1500],["owner","csrf",601001],["owner","csrf",999]] as const)expect(validQuickBooksOAuthState(state,user,csrf,time)).toBe(false);
    expect(validQuickBooksOAuthState(`${state}bad`,"owner","csrf",1500)).toBe(false);
    expect(await consumeQuickBooksOAuthState(state,"owner")).toBe(true);expect(await consumeQuickBooksOAuthState(state,"owner")).toBe(false);
  });
  it("retains the previous connection if atomic replacement fails",async()=>{
    const old=structuredClone(mocks.connection);mocks.failInsert=true;
    await expect(replaceQuickBooksConnection({...old,id:"connection-b"})).rejects.toThrow(/insert failed/);
    expect(mocks.connection).toEqual(old);expect(mocks.events).toContain("company_lock");
  });
  it("rejects a foreign connection, live demo access and unverified Projects without sending",async()=>{
    await expect(qboRequest("/invoice/1",{},"other")).rejects.toThrow(/connection changed/);
    mocks.connection.environment="production";vi.stubEnv("DEMO_MODE","true");await expect(qboRequest("/invoice/1")).rejects.toThrow(/demonstration/);
    expect(quickBooksProjectReadiness()).toMatchObject({verified:false,readiness:"blocked",legacySubcustomersPreserved:true});expect(()=>requireQuickBooksProjects()).toThrow(/subcustomer is not/);expect(fetch).not.toHaveBeenCalled();
  });
});
