import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({connection:null as any,nonceIds:new Set<string>(),failInsert:false,failRevocationResult:false,events:[] as string[],queue:Promise.resolve()}));
vi.mock("@workspace/db/workspace",()=>({workspaceEnvironment:()=>process.env,workspaceScopeKey:()=>"test"}));
vi.mock("@workspace/db",async()=>{
  const schema=await import("../../../../lib/db/src/schema/index");const {getTableName}=await import("drizzle-orm");
  const read=()=>({from:()=>({limit:async()=>mocks.connection?[structuredClone(mocks.connection)]:[],where:()=>({for:async()=>{mocks.events.push("row_lock");return mocks.connection?[structuredClone(mocks.connection)]:[];}})})});
  const db:any={select:read,execute:async()=>{mocks.events.push("company_lock");},delete:async()=>{mocks.connection=null;},update:()=>({set:(values:any)=>({where:()=>{if(mocks.failRevocationResult&&values.readinessStatus?.startsWith("revocation_")&&values.readinessStatus!=="revocation_pending")throw new Error("database result write failed");Object.assign(mocks.connection,values);return {returning:async()=>[structuredClone(mocks.connection)],then:(resolve:any)=>Promise.resolve().then(resolve)};}})}),
    insert:(table:any)=>({values:(data:any)=>{
      if(getTableName(table)==="audit_events")return {onConflictDoNothing:()=>({returning:async()=>{if(mocks.nonceIds.has(data.id))return [];mocks.nonceIds.add(data.id);return [{id:data.id}];}})};
      if(mocks.failInsert)throw new Error("insert failed");mocks.connection=structuredClone(data);return Promise.resolve();
    }}),
  };
  db.transaction=async(fn:any)=>{const preceding=mocks.queue;let done!:()=>void;mocks.queue=new Promise<void>(resolve=>{done=resolve;});await preceding;const original=structuredClone(mocks.connection);try{return await fn(db);}catch(error){mocks.connection=original;throw error;}finally{done();}};
  return {...schema,db};
});
import {accountingScope,projectsScope,grantedQuickBooksScopes,quickBooksOAuthRequestedScopes,quickBooksConnectionLifecycle,quickBooksOAuthConnectionLifecycle,consumeQuickBooksOAuthState,createQuickBooksOAuthState,signOAuthState,verifyOAuthState,encryptSecret,decryptSecret,disconnectQuickBooks,qboRequest,qboProjectsGraph,quickBooksProjectReadiness,replaceQuickBooksConnection,requireQuickBooksProjects,validQuickBooksOAuthState} from "./quickbooks";

describe("QuickBooks connection safety",()=>{
  beforeEach(()=>{
    vi.stubEnv("QUICKBOOKS_ENCRYPTION_KEY","synthetic-key-at-least-thirty-two-characters");vi.stubEnv("QUICKBOOKS_CLIENT_ID","test");vi.stubEnv("QUICKBOOKS_CLIENT_SECRET","test");vi.stubEnv("DEMO_MODE","false");vi.stubEnv("QUICKBOOKS_ENVIRONMENT","production");
    mocks.connection={id:"connection-a",realmId:"123",environment:"sandbox",status:"connected",encryptedAccessToken:encryptSecret("expired"),encryptedRefreshToken:encryptSecret("refresh"),accessTokenExpiresAt:"2000-01-01T00:00:00Z"};
    mocks.nonceIds.clear();mocks.failInsert=false;mocks.failRevocationResult=false;mocks.events=[];mocks.queue=Promise.resolve();vi.stubGlobal("fetch",vi.fn());
  });
  afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
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
  it("binds incremental scope consent to signed single-use state and handles documented omitted scope",async()=>{
    const state=createQuickBooksOAuthState("owner","csrf",1000,[accountingScope,projectsScope]);
    expect(quickBooksOAuthRequestedScopes(state)).toEqual([accountingScope,projectsScope]);
    expect(grantedQuickBooksScopes(undefined,quickBooksOAuthRequestedScopes(state))).toEqual([accountingScope,projectsScope]);
    expect(grantedQuickBooksScopes(accountingScope,quickBooksOAuthRequestedScopes(state))).toEqual([accountingScope]);
    expect(()=>grantedQuickBooksScopes(`${accountingScope} malicious.scope`,quickBooksOAuthRequestedScopes(state))).toThrow(/unrequested/);
    expect(validQuickBooksOAuthState(state.replace(projectsScope,"other.scope"),"owner","csrf",1100)).toBe(false);
    expect(await consumeQuickBooksOAuthState(state,"owner")).toBe(true);expect(await consumeQuickBooksOAuthState(state,"owner")).toBe(false);
  });
  it("preserves only saved grant scopes on refresh and applies an actual reduced grant",async()=>{
    mocks.connection.grantedScopes=[accountingScope,projectsScope];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({access_token:"fresh",refresh_token:"new",expires_in:3600,x_refresh_token_expires_in:86400})).mockResolvedValueOnce(Response.json({ok:true}));
    await qboRequest("/preferences");expect(mocks.connection.grantedScopes).toEqual([accountingScope,projectsScope]);
    mocks.connection.accessTokenExpiresAt="2000-01-01";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({access_token:"fresh2",refresh_token:"new2",expires_in:3600,x_refresh_token_expires_in:86400,scope:accountingScope})).mockResolvedValueOnce(Response.json({ok:true}));
    await qboRequest("/preferences");expect(mocks.connection.grantedScopes).toEqual([accountingScope]);
  });
  it("never retries a GraphQL mutation after rejection or an ambiguous network response",async()=>{
    mocks.connection.grantedScopes=[projectsScope];mocks.connection.accessTokenExpiresAt="2099-01-01";
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:401}));
    await expect(qboProjectsGraph("mutation","mutation Create { result }",{},"connection-a")).rejects.toMatchObject({submissionUnknown:false});expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("response lost"));
    await expect(qboProjectsGraph("mutation","mutation Create { result }",{},"connection-a")).rejects.toMatchObject({submissionUnknown:true});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects a foreign connection, live demo access and unverified Projects without sending",async()=>{
    await expect(qboRequest("/invoice/1",{},"other")).rejects.toThrow(/connection changed/);
    mocks.connection.environment="production";vi.stubEnv("DEMO_MODE","true");await expect(qboRequest("/invoice/1")).rejects.toThrow(/demonstration/);
    expect(quickBooksProjectReadiness()).toMatchObject({verified:false,readiness:"blocked",legacySubcustomersPreserved:true});expect(()=>requireQuickBooksProjects()).toThrow(/subcustomer is not/);expect(fetch).not.toHaveBeenCalled();
  });

  it("commits the local stop before revoking the saved grant and clears tokens only on Intuit HTTP 200",async()=>{
    vi.mocked(fetch).mockImplementation(async(url,options)=>{
      expect(String(url)).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
      expect(mocks.connection).toMatchObject({status:"disconnected",readinessStatus:"revocation_pending"});
      expect(options).toMatchObject({method:"POST",redirect:"error",headers:{Authorization:`Basic ${Buffer.from("test:test").toString("base64")}`,"Content-Type":"application/json"},body:JSON.stringify({token:"refresh"})});
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null,{status:200});
    });
    expect(await disconnectQuickBooks()).toMatchObject({locallyDisconnected:true,revocation:"confirmed"});
    expect(mocks.connection.readinessStatus).toBe("revocation_confirmed");
    expect(decryptSecret(mocks.connection.encryptedAccessToken)).toBe("revoked");
    expect(decryptSecret(mocks.connection.encryptedRefreshToken)).toBe("revoked");
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"confirmed"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a stopped grant on lost response, blocks reconnect and refresh, and retries only by owner action",async()=>{
    const encryptedGrant=mocks.connection.encryptedRefreshToken;
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Intuit accepted but its response was lost"));
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"unknown"});
    expect(mocks.connection).toMatchObject({status:"disconnected",readinessStatus:"revocation_unknown",encryptedRefreshToken:encryptedGrant});
    await expect(qboRequest("/preferences")).rejects.toThrow(/not connected/);
    await expect(replaceQuickBooksConnection({...mocks.connection,id:"new-company",readinessStatus:"reconciliation_required",status:"connected"})).rejects.toMatchObject({status:409});
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"unknown"});
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:200}));
    expect(await disconnectQuickBooks(true)).toMatchObject({revocation:"confirmed"});
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({token:"refresh"});
    await replaceQuickBooksConnection({...mocks.connection,id:"new-company",readinessStatus:"reconciliation_required",status:"connected"});
    expect(mocks.connection.id).toBe("new-company");
  });

  it("does not issue a second revoke while the first owner's bounded request is pending",async()=>{
    let release!:(response:Response)=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(fetch).mockImplementation(async()=>{started();return new Promise<Response>(resolve=>{release=resolve;});});
    const first=disconnectQuickBooks();await entered;
    expect(await disconnectQuickBooks(true)).toMatchObject({revocation:"pending"});
    await expect(replaceQuickBooksConnection({...mocks.connection,id:"replacement",readinessStatus:"ready",status:"connected"})).rejects.toMatchObject({status:409});
    expect(fetch).toHaveBeenCalledTimes(1);
    release(new Response(null,{status:200}));expect(await first).toMatchObject({revocation:"confirmed"});
  });

  it("waits for a concurrent refresh and revokes its latest persisted refresh token",async()=>{
    let release!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const responseReady=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(fetch).mockImplementation(async(url,options)=>{
      if(String(url).includes("tokens/bearer")){started();await responseReady;return Response.json({access_token:"fresh",refresh_token:"rotated-for-disconnect",expires_in:3600,x_refresh_token_expires_in:86400});}
      if(String(url).endsWith("tokens/revoke")){
        expect(mocks.connection.status).toBe("disconnected");
        expect(JSON.parse(options!.body as string)).toEqual({token:"rotated-for-disconnect"});
        return new Response(null,{status:200});
      }
      return Response.json({ok:true});
    });
    const refreshing=qboRequest("/preferences");await entered;
    const disconnecting=disconnectQuickBooks();release();
    await refreshing;expect(await disconnecting).toMatchObject({revocation:"confirmed"});
    expect(mocks.connection.status).toBe("disconnected");
    await expect(qboRequest("/preferences")).rejects.toThrow(/not connected/);
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).includes("tokens/bearer"))).toHaveLength(1);
  });

  it.each([[400,"failed"],[429,"failed"],[408,"unknown"],[500,"unknown"],[202,"unknown"]] as const)("does not claim remote revocation for provider status %s",async(status,expected)=>{
    const saved=mocks.connection.encryptedRefreshToken;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status}));
    expect(await disconnectQuickBooks()).toMatchObject({revocation:expected});
    expect(mocks.connection).toMatchObject({status:"disconnected",encryptedRefreshToken:saved});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale pending claim only on an explicit retry and never regresses a newer confirmed result",async()=>{
    let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);
    let release!:(response:Response)=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(fetch).mockImplementationOnce(async()=>{started();return new Promise<Response>(resolve=>{release=resolve;});}).mockResolvedValueOnce(new Response(null,{status:200}));
    const first=disconnectQuickBooks();await entered;now+=31_000;
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"pending"});expect(fetch).toHaveBeenCalledTimes(1);
    expect(await disconnectQuickBooks(true)).toMatchObject({revocation:"confirmed"});
    release(new Response(null,{status:500}));await first;
    expect(mocks.connection).toMatchObject({status:"disconnected",readinessStatus:"revocation_confirmed"});
    expect(decryptSecret(mocks.connection.encryptedRefreshToken)).toBe("revoked");
  });

  it("retains the encrypted grant and local stop if the database result write fails after Intuit success",async()=>{
    mocks.failRevocationResult=true;
    const originalGrant=mocks.connection.encryptedRefreshToken;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:200}));
    await expect(disconnectQuickBooks()).rejects.toMatchObject({status:503});
    expect(mocks.connection).toMatchObject({status:"disconnected",readinessStatus:"revocation_pending",encryptedRefreshToken:originalGrant});
    await expect(qboRequest("/preferences")).rejects.toThrow(/not connected/);
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"pending"});
    expect(fetch).toHaveBeenCalledTimes(1);
    mocks.failRevocationResult=false;mocks.connection.updatedAt=new Date(Date.now()-31_000).toISOString();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:200}));
    expect(await disconnectQuickBooks(true)).toMatchObject({revocation:"confirmed"});
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({token:"refresh"});
  });

  it("serializes an already-open OAuth exchange with disconnect and revokes the newly saved grant",async()=>{
    const previous=structuredClone(mocks.connection);
    let release!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const exchangeReady=new Promise<void>(resolve=>{release=resolve;});
    const replacing=replaceQuickBooksConnection(async()=>{started();await exchangeReady;return {...previous,id:"replacement",readinessStatus:"reconciliation_required",encryptedRefreshToken:encryptSecret("new-consent-grant")};},quickBooksConnectionLifecycle(previous));
    await entered;
    vi.mocked(fetch).mockImplementation(async(_url,options)=>{expect(JSON.parse(options!.body as string)).toEqual({token:"new-consent-grant"});return new Response(null,{status:200});});
    const disconnecting=disconnectQuickBooks();release();await replacing;
    expect(await disconnecting).toMatchObject({revocation:"confirmed"});
    expect(mocks.connection).toMatchObject({id:"replacement",status:"disconnected",readinessStatus:"revocation_confirmed"});
    expect(fetch).toHaveBeenCalledTimes(1);
    mocks.connection.readinessStatus="revocation_unknown";
    const exchange=vi.fn(async()=>previous);
    await expect(replaceQuickBooksConnection(exchange)).rejects.toMatchObject({status:409});
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects a pre-disconnect OAuth state after confirmed revocation but accepts freshly initiated consent",async()=>{
    const old=structuredClone(mocks.connection);
    const staleState=createQuickBooksOAuthState("owner","csrf",Date.now(),[accountingScope],quickBooksConnectionLifecycle(old));
    const staleLifecycle=quickBooksOAuthConnectionLifecycle(staleState);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:200}));
    expect(await disconnectQuickBooks()).toMatchObject({revocation:"confirmed"});
    const exchange=vi.fn(async()=>({...old,id:"fresh-connection",readinessStatus:"reconciliation_required"}));
    await expect(replaceQuickBooksConnection(exchange,staleLifecycle)).rejects.toMatchObject({status:409});
    expect(exchange).not.toHaveBeenCalled();
    const freshState=createQuickBooksOAuthState("owner","csrf",Date.now(),[accountingScope],quickBooksConnectionLifecycle(mocks.connection));
    await replaceQuickBooksConnection(exchange,quickBooksOAuthConnectionLifecycle(freshState));
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(mocks.connection).toMatchObject({id:"fresh-connection",status:"connected",readinessStatus:"reconciliation_required"});
  });

  it("fails closed for legacy unbound state and accepts a null lifecycle only while no connection exists",async()=>{
    const signed=createQuickBooksOAuthState("owner","csrf");
    const data=JSON.parse(verifyOAuthState(signed)!);delete data.connectionLifecycle;
    expect(validQuickBooksOAuthState(signOAuthState(JSON.stringify(data)),"owner","csrf")).toBe(false);
    const original=structuredClone(mocks.connection);
    const exchange=vi.fn(async()=>original);
    await expect(replaceQuickBooksConnection(exchange,quickBooksOAuthConnectionLifecycle(signed))).rejects.toMatchObject({status:409});
    expect(exchange).not.toHaveBeenCalled();
    mocks.connection=null;
    await replaceQuickBooksConnection(exchange,quickBooksOAuthConnectionLifecycle(signed));
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(mocks.connection.id).toBe(original.id);
  });
});
