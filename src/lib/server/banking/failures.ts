import type { BankListFailureCode } from '$lib/domain/failureCodes';
import type { FailureRecogniser } from '$lib/server/errors';
import { EnableBankingApiError } from './enablebanking/http';
import { EnableBankingConfigurationError } from './enablebanking/jwt';

/**
 * Recognises the two failures the banking layer has ALREADY classified for itself.
 *
 * The point of #524 is that this classification is not new work: `EnableBankingApiError` has
 * carried a status and a provider code since it was written, and the configuration throws have
 * always named the variable to set. Both were built, and then discarded one frame from the screen
 * by a bare `catch`. This function is the frame that was missing, not a new diagnosis.
 *
 * `instanceof` rather than a name check, unlike the Ollama client's internal `ResponseError`: both
 * classes are ours and are imported through the ordinary module graph, so the constructor identity
 * is the strongest available signal and the compiler checks the import.
 */
export const recogniseBankListFailure: FailureRecogniser<BankListFailureCode> = (caught) => {
	if (caught instanceof EnableBankingConfigurationError) return 'not_configured';
	if (caught instanceof EnableBankingApiError) return 'provider_error';
	return null;
};
