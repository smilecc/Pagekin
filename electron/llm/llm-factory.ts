import { ILLMProvider } from './provider.interface'
import { ModelProfile } from '../../src/shared/ipc-channels'
import { OpenAIProvider } from './openai-provider'
import { GeminiProvider } from './gemini-provider'
import { LoggedLLMProvider } from './request-log'

export class LLMFactory {
  static getProvider(model: ModelProfile): ILLMProvider {
    if (model.protocol === 'gemini') {
      return new LoggedLLMProvider(new GeminiProvider())
    }
    return new LoggedLLMProvider(new OpenAIProvider())
  }
}
