class OpenAIEmbeddingFunction:
    def __init__(self, api_key=None, model_name="text-embedding-ada-002", **kw):
        self.model_name = model_name

    def _tag(self):
        return {"$ef": {"kind": "openai", "model": self.model_name}}
