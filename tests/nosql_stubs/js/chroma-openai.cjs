class OpenAIEmbeddingFunction {
  constructor(o) { this.model = o.modelName; }
  _tag() { return { $ef: { kind: "openai", model: this.model } }; }
}
exports.OpenAIEmbeddingFunction = OpenAIEmbeddingFunction;
