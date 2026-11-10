"""Examples of using the wrapper from your own Python code.  Run: python example.py"""

from openrouter_client import OpenRouterClient

client = OpenRouterClient()

# 1. One question, one answer (default model)
print(client.ask("Say hello in 3 languages, one line each."))

# 2. The same question to different models
for model in ["gpt", "gemini", "claude"]:
    answer = client.ask("What is 17 * 23? Reply with only the number.", model=model)
    print(f"{model:>8}: {answer.strip()}")

# 3. System prompt + extra options (any OpenRouter parameter works as a keyword)
print(client.ask(
    "I love programming.",
    model="claude",
    system="Translate the user's text to French. Reply with the translation only.",
    temperature=0,
))

# 4. Multi-turn conversation: keep a list of messages
messages = [
    {"role": "system", "content": "You are a concise assistant."},
    {"role": "user", "content": "My name is Sara."},
]
messages.append({"role": "assistant", "content": client.chat(messages, model="gemini")})
messages.append({"role": "user", "content": "What is my name?"})
print(client.chat(messages, model="gemini"))

# 5. Streaming: print the answer while it is being written
for piece in client.ask_stream("Write a haiku about the sea.", model="gpt"):
    print(piece, end="", flush=True)
print()

# 6. Token usage / cost of the last call
print(client.last_model, client.last_usage)

# 7. A decision model (TypeSafe's Jev): typed questions in, probabilities out
result = client.decide(
    state="My checkout page shows a blank screen after I click Pay.",
    questions={
        "is_bug": {"type": "noul", "instructions": "Is the customer reporting a software defect?"},
        "team": {"type": "choice", "instructions": "Which team should own this ticket?",
                 "criteria": {"payments": "Checkout or billing", "frontend": "Rendering or browsers", "account": "Login"}},
    },
    model="jev",
)
print(result["answers"]["is_bug"]["noul"], result["answers"]["team"]["choice"], result["usage"]["cost"])

# 8. Structured output: the answer comes back as typed Python data (bool, int, list, ...)
schema = {
    "type": "object",
    "properties": {
        "is_bug": {"type": "boolean"},
        "priority": {"type": "integer", "description": "1 = can wait ... 5 = urgent"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["is_bug", "priority", "tags"],
    "additionalProperties": False,
}
data = client.ask_json("My checkout page is blank after I click Pay.", schema, model="gpt")
print(data["is_bug"], data["priority"], data["tags"])

# 9. An extraction model: typed fields pulled out of text, each with a confidence
result = client.extract(
    state="Invoice INV-2291 issued 2026-09-02, net 30. Total $1080.",
    fields={"invoice_number": {"type": "text"}, "total": {"type": "number", "unit": "USD"},
            "due_date": {"type": "date", "instructions": "Issue date plus the net payment days"}},
    model="cloudflare/clairic",
    reference_date="2026-11-10",
)
print({name: answer["value"] for name, answer in result["answers"].items()})
