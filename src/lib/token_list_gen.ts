import {  minVersionBump, nextVersion, Version, diffTokenLists, VersionUpgrade } from '@uniswap/token-lists';
import { instantiateBridge } from './instantiate_bridge';
import { getAllTokens, getTokens } from './graph';

import { ArbTokenList, ArbTokenInfo, EtherscanList } from './types';
import {
  getL2TokenData,
  getL2TokenAddresses,
  getLogoUri,
  getTokenListObj,
  listNameToFileName,
  validateTokenList,
  sanitizeString,
  getPostWhiteListedTokens,
  listNameToArbifiedListName
} from './utils';
import { writeFileSync, writeFile, readFileSync, existsSync } from 'fs';

export interface ArbificationOptions {
  overwriteCurrentList: boolean;
}

export interface L2ToL1GatewayAddresses {
  [contractAddress: string]: string;
}
const l2ToL1GatewayAddresses: L2ToL1GatewayAddresses = {
  '0x09e9222e96e7b4ae2a407b98d48e330053351eee':
    '0xa3A7B6F88361F48403514059F1F16C8E78d60EeC',
  '0x096760f208390250649e3e8763348e783aef5562':
    '0xcEe284F754E854890e311e3280b767F80797180d',
  '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b':
    '0xd92023E9d9911199a6711321D1277285e6d4e2db',
  '0x467194771dae2967aef3ecbedd3bf9a310c76c65':
    '0xD3B5b60020504bc3489D6949d545893982BA3011',
};

export const generateTokenList = async (
  _l1TokenAddresses: string[] | 'all',
  name: string,
  mainLogoUri?: string,
  prevArbTokenList?: ArbTokenList
) => {
  const bridgeData = await instantiateBridge();
  const { bridge, l1Network, l2Network } = bridgeData;
  let tokens =
    _l1TokenAddresses === 'all'
      ? await getAllTokens(l2Network.chainID)
      : await getTokens(_l1TokenAddresses, l2Network.chainID);
  
  // /** Temporary workaround until we handle this in subgraph: find all post-whitelisting bridged tokens via event logs */
  if(_l1TokenAddresses === 'all'){
    const whitelistedEral1TokenAddresses = tokens.map((token) => token.id)
    const newTokens = await getPostWhiteListedTokens(bridge, {excludeList:whitelistedEral1TokenAddresses })    
    tokens = tokens.concat(newTokens)
  } else {
    const whitelistedEral1TokenAddresses = tokens.map((token) => token.id)
    const newTokens = await getPostWhiteListedTokens(bridge, {excludeList:whitelistedEral1TokenAddresses, includeList:_l1TokenAddresses })    
    tokens = tokens.concat(newTokens)
  }
  
  const l1TokenAddresses = tokens.map((token) => token.id);
  const l2Addresses = await getL2TokenAddresses(l1TokenAddresses, bridge);
  const tokenData = await getL2TokenData(l2Addresses, bridge);
  const logoUris: (string | undefined)[] = [];
  for (const token of tokens) {
    const uri = await getLogoUri(token.id);
    logoUris.push(uri);
  }

  const tokenList = tokens.map((token, i: number) => {
    // TODO: hex data slice
    const l2GatewayAddress = token.gateway[0].id.slice(0, 42) as string;
    const address = l2Addresses[i];
    let { name:_name, decimals, symbol:_symbol } = tokenData[i];
    const name = sanitizeString(_name)
    const symbol = sanitizeString(_symbol)

    let arbTokenInfo = {
      chainId: +l2Network.chainID,
      address: address,
      name,
      symbol,
      decimals,
      extensions: {
        bridgeInfo: {
          [l1Network.chainID]: {
            tokenAddress: token.id,
            originBridgeAddress: l2GatewayAddress,
            destBridgeAddress: l2ToL1GatewayAddresses[l2GatewayAddress.toLowerCase()]
          }
        }
  
      }
    };
    if (logoUris[i]) {
      arbTokenInfo = { ...{ logoURI: logoUris[i] }, ...arbTokenInfo };
    } else {
      console.log('no logo uri for ',token.id, symbol);
      
    }

    return arbTokenInfo;
  }).filter((tokenInfo: ArbTokenInfo)=>{
    return tokenInfo.extensions.bridgeInfo[l1Network.chainID].originBridgeAddress !== "0x0000000000000000000000000000000000000001" 
  })
  tokenList.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  const version = (()=>{
    /** 
     * TODO: re-enable autoamted version bumping when the token-list lib includes the new interfaces 
    // if(prevArbTokenList){
    //   let versionBump = minVersionBump(prevArbTokenList.tokens, tokenList)

    //   // tmp: library doesn't nicely handle patches (for extensions object)
    //   if(versionBump === VersionUpgrade.PATCH){
    //     versionBump = VersionUpgrade.NONE
    //   }
      
      
    //   return nextVersion(prevArbTokenList.version, versionBump)  
    // }
    */
    return  {
      major: 1,
      minor: 0,
      patch: 0,
    }
  })()

  const arbTokenList: ArbTokenList = {
    name: listNameToArbifiedListName(name),
    timestamp: new Date().toISOString(),
    version,
    tokens: tokenList,
    logoURI: mainLogoUri
  };
  /**
   * * TODO: re-enable autoamted version bumping when the token-list lib includes the new token list json schema 
  const res = validateTokenList(arbTokenList);
  if(!res){
    console.log("Token list invalid — let's try to see why:");
    while(arbTokenList.tokens.length > 0){
      const candidateToken = arbTokenList.tokens.pop()
      const res = validateTokenList(arbTokenList);
      if (res){
        console.log('This token is a problem:', candidateToken);
        throw new Error('Invalid token list')

      }
    }
    throw new Error('Invalid token list (not sure why)')
    
  }
  console.log(`Generated list with ${arbTokenList.tokens.length} tokens`);
  */
  
  return arbTokenList;
};

export const arbifyL1List = async (pathOrUrl: string) => {
  const l1TokenList = await getTokenListObj(pathOrUrl);
  const path = process.env.PWD +
  '/src/ArbTokenLists/' +
  listNameToFileName(l1TokenList.name);
  let prevArbTokenList: ArbTokenList | undefined; 

  if(existsSync(path)){
    const data = readFileSync(path)
    prevArbTokenList =  JSON.parse(data.toString()) as ArbTokenList
  } 

  const l1Addresses = l1TokenList.tokens.map((token) =>
    token.address.toLowerCase()
  );

  const newList = await generateTokenList(l1Addresses, l1TokenList.name, l1TokenList.logoURI, prevArbTokenList);

  writeFileSync(path, JSON.stringify(newList));
  console.log('Token list generated at', path );
  
};

export const arbListtoEtherscanList = (arbList: ArbTokenList): EtherscanList=> {
  return arbList.tokens.map((tokenInfo)=>{
    const { address: l2Address} =  tokenInfo;
    const {  tokenAddress, originBridgeAddress, destBridgeAddress} = tokenInfo.extensions.bridgeInfo['1']
    return {
      l1Address:tokenAddress,
      l2Address,
      l1GatewayAddress:destBridgeAddress,
      l2GatewayAddress:originBridgeAddress
    }
  })
}
