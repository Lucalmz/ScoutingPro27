import type { OfficialMatch } from '@/types'

export async function fetchEventMatches(season: number, eventCode: string): Promise<OfficialMatch[]> {
  const query = `
    query GetEventMatches($season: Int!, $code: String!) {
      eventByCode(season: $season, code: $code) {
        matches {
          matchNum
          scores {
            ... on MatchScores2025 {
              red {
                penaltyPointsCommitted
                totalPointsNp
              }
              blue {
                penaltyPointsCommitted
                totalPointsNp
              }
            }
          }
          teams {
            teamNumber
            alliance
          }
        }
      }
    }
  `;

  try {
    const res = await fetch('https://api.ftcscout.org/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { season, code: eventCode }
      })
    });

    const json = await res.json();
    console.log("GraphQL Response:", JSON.stringify(json, null, 2));
    return json.data?.eventByCode?.matches || [];
  } catch (e) {
    console.error('Failed to fetch event matches', e);
    return [];
  }
}
