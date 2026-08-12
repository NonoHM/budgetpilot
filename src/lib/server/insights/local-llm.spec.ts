import { describe, expect, it, vi } from 'vitest';
import { requestLocalBudgetInsights } from './local-llm';

describe('requestLocalBudgetInsights', () => {
	it('refuse une URL LLM non locale sans appeler fetch', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://example.com'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('refuse une redirection Ollama vers un hôte non autorisé (#215) et ne le contacte jamais', async () => {
		expect.assertions(3);

		// Base URL allowlisted, but Ollama answers 302 to a non-allowlisted internal host.
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: 'http://127.0.0.2:9998/latest/meta-data/' }
			})
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		// Only the first (allowlisted) hop ran; the internal target was never requested.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
			'http://127.0.0.2:9998/latest/meta-data/'
		);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand le contenu renvoyé par Ollama n’est pas du JSON valide', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: { content: 'ceci n’est pas du JSON' }
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		expect(result?.insights).toEqual([]);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand le JSON est syntaxiquement valide mais hors schéma (title manquant)', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({
							summary: 'ok',
							insights: [{ message: 'sans titre', severity: 'info', category: 'budget' }]
						})
					}
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		expect(result?.insights).toEqual([]);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand un champ dépasse la longueur maximale autorisée', async () => {
		expect.assertions(1);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({ summary: 'x'.repeat(161), insights: [] })
					}
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('n’appelle jamais fetch quand LLM_ALLOWED_HOSTS ne whiteliste pas l’hôte fourni', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'un-autre-hote.example'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte un hôte custom listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({ summary: 'ok', insights: [] })
					}
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://host.docker.internal:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('rejette un hôte non listé même quand LLM_ALLOWED_HOSTS est renseigné avec d’autres hôtes', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://autre-hote.example:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal, localhost'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('rejette un protocole non-HTTP même avec LLM_ALLOWED_HOSTS renseigné', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('reste strict par défaut (localhost/127.0.0.1/::1 uniquement) quand LLM_ALLOWED_HOSTS est absent', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte toujours 127.0.0.1 quand LLM_ALLOWED_HOSTS est absent', async () => {
		expect.assertions(1);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
				}),
				{ status: 200 }
			)
		);
		await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(fetchMock).toHaveBeenCalled();

		fetchMock.mockRestore();
	});

	it('rejette http: pour un hôte distant non-Docker même listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://vps.example.com:11434',
			LLM_ALLOWED_HOSTS: 'vps.example.com'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte https: pour un hôte distant non-Docker listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://vps.example.com:11434',
			LLM_ALLOWED_HOSTS: 'vps.example.com'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://vps.example.com:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('rejette http: pour un hôte non-loopback non listé dans LLM_HTTP_PERMITTED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://ollama:11434',
			LLM_ALLOWED_HOSTS: 'ollama'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte http: pour un hôte listé dans LLM_HTTP_PERMITTED_HOSTS (ex. service Docker Compose)', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://ollama:11434',
			LLM_ALLOWED_HOSTS: 'ollama',
			LLM_HTTP_PERMITTED_HOSTS: 'ollama'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://ollama:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('autorise Ollama sur localhost', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({ summary: 'ok', insights: [] })
					}
				}),
				{ status: 200 }
			)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});
});
