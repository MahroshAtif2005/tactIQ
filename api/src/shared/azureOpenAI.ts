import { FatigueAgentRequest, FatigueModelResult } from './types';

export async function generateAzureExplanation(input: FatigueAgentRequest, result: FatigueModelResult): Promise<string | null> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';

  if (!endpoint || !apiKey || !deployment) {
    return null;
  }

  try {
    const normalized = endpoint.replace(/\/$/, '');
    const url = `${normalized}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are a cricket sports science assistant. Return only a concise 1-2 sentence explanation.'
          },
          {
            role: 'user',
            content: `Player ${input.playerName} (${input.role}) measuredFatigue=${input.fatigueIndex}, advisorySeverity=${result.severity}, signals=${result.signals.join(',') || 'NONE'}. Explain in 1-2 sentences.`
          }
        ],
        max_tokens: 80,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content || null;
  } catch {
    return null;
  }
}
