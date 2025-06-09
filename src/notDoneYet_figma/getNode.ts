import { GetFileNodesResponse } from '@figma/rest-api-spec';
import { SimplifiedDesign } from './simplfiedDesign';

export const getNode = async (
  fileKey: string,
  nodeId: string,
  depth?: number | null
) => {
  const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${
    depth ? `&depth=${depth}` : ''
  }`;
  const response = await fetch(endpoint);
  const responseData = (await response.json()) as GetFileNodesResponse;
  console.log('Got response from getNode, now parsing.');
  console.log('figma-raw.yml', response);
  const simplifiedResponse = parseFigmaResponse(responseData);
  console.log('figma-simplified.yml', simplifiedResponse);
  return simplifiedResponse;
};
