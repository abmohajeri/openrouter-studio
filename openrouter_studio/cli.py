#!/usr/bin/env python3
"""Command-line tool for OpenRouter.  Run `openrouter -h` (or `python main.py -h`) for help."""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    print("OpenRouter Studio requires Python 3.9 or newer.", file=sys.stderr)
    sys.exit(1)

import requests

from .client import (
    DEFAULT_MODEL,
    ENV_FILE,
    MODEL_ALIASES,
    OpenRouterClient,
    OpenRouterError,
    fetch_models,
    resolve_model,
    save_api_key,
)

EXAMPLES = """\
examples (from the project folder, use `python main.py` instead of `openrouter`):
  openrouter --setup                                 save your API key (once)
  openrouter "What is Python?"                       ask the default model
  openrouter -m gemini "Explain black holes"         pick a model by alias
  openrouter -m openai/gpt-5.5 "Hi"                  ...or by full OpenRouter id
  openrouter -m gpt,claude,gemini "Tell a joke"      compare several models
  openrouter -m claude -i input.txt -o output.txt    file in -> file out
  openrouter -i report.txt "Summarize this:"         prompt + file content
  cat notes.txt | openrouter -m deepseek             read input from stdin
  openrouter -s "Translate to French" "Good morning" with a system prompt
  openrouter --chat -m claude                        interactive chat
  openrouter --aliases                               show the short model names
  openrouter --list-models gemini                    search all OpenRouter models
  openrouter --usage                                 your key's limit and spending
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Call GPT, Gemini, Claude, DeepSeek, ... through OpenRouter.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("prompt", nargs="?", help="your prompt (or use -i FILE / stdin)")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL,
                   help=f"alias or full model id; comma-separate to compare (default: {DEFAULT_MODEL})")
    p.add_argument("-i", "--input", help="read input from a file ('-' = stdin)")
    p.add_argument("-o", "--output", type=Path, help="write the answer to this file")
    p.add_argument("-s", "--system", help="system prompt (instructions for the model)")
    p.add_argument("-t", "--temperature", type=float, help="randomness, e.g. 0 to 1")
    p.add_argument("--max-tokens", type=int, help="limit the answer length")
    p.add_argument("--no-stream", action="store_true", help="print the answer only when it is complete")
    p.add_argument("-v", "--verbose", action="store_true", help="show the model used, tokens and cost")
    p.add_argument("--chat", action="store_true", help="interactive multi-turn chat")
    p.add_argument("--setup", action="store_true", help="save your OpenRouter API key into .env")
    p.add_argument("--aliases", action="store_true", help="list the built-in model aliases")
    p.add_argument("--usage", action="store_true", help="show your API key's spending limit and usage")
    p.add_argument("--list-models", nargs="?", const="", metavar="FILTER",
                   help="list all OpenRouter models, optionally filtered by text")
    return p.parse_args()


def info(msg: str) -> None:
    """Status messages go to stderr so they never mix with the model's answer."""
    sys.stdout.flush()
    print(msg, file=sys.stderr)


# ---- commands -------------------------------------------------------------------

def setup() -> int:
    key = getpass.getpass("Paste your OpenRouter API key (input is hidden): ").strip()
    if not key:
        info("No key entered, nothing saved.")
        return 1
    # Check the key first so a typo never replaces a working key in .env.
    try:
        data = OpenRouterClient(api_key=key).key_info()
    except OpenRouterError as e:
        info(f"OpenRouter did not accept this key ({e}). Nothing saved.")
        return 1
    except requests.RequestException as e:
        info(f"Couldn't reach OpenRouter to check the key ({e}). Nothing saved.")
        return 1
    try:
        save_api_key(key)
    except ValueError as e:
        info(f"Not saved: {e}.")
        return 1
    info(f"Saved to {ENV_FILE}")
    limit = data.get("limit")
    info(f"Key works. Label: {data.get('label') or '?'}, "
         f"used: {money(data.get('usage'))}, limit: {'none' if limit is None else money(limit)}")
    return 0


def money(v) -> str:
    v = v or 0
    return f"${v:.4f}" if 0 < abs(v) < 0.01 else f"${v:,.2f}"


def show_usage() -> int:
    client = OpenRouterClient()
    k = client.key_info()
    print(f"API key    {k.get('label', '?')}  ({'free tier' if k.get('is_free_tier') else 'paid'})")
    limit = k.get("limit")
    if limit is None:
        print("Limit      none (this key can spend up to your account balance)")
    else:
        left = k.get("limit_remaining")
        left = limit - (k.get("usage") or 0) if left is None else left
        pct = (limit - left) / limit * 100 if limit else 100
        print(f"Limit      {money(limit)}, resets {k.get('limit_reset') or 'never'} · {money(left)} left ({pct:.0f}% used)")
    spent = [(label, k.get(field)) for label, field in
             (("today", "usage_daily"), ("week", "usage_weekly"), ("month", "usage_monthly"), ("all time", "usage"))]
    print("Spent      " + " · ".join(f"{label} {money(v)}" for label, v in spent if v is not None))
    for b in k.get("budgets") or []:
        print(f"Budget     {b.get('scope')}: {money(b.get('spend_usd'))} of {money(b.get('limit_usd'))}"
              f", resets {b.get('reset_interval') or 'never'}")
    free = k.get("free_model_daily_requests")
    if free:
        print(f"Free reqs  {free.get('used')} of {free.get('limit')} free-model requests used today")
    try:
        a = client.credits()
        bought, used = a.get("total_credits") or 0, a.get("total_usage") or 0
        print(f"Account    {money(bought - used)} left ({money(bought)} bought)")
    except (OpenRouterError, requests.RequestException):
        print("Account    balance needs a management key; see https://openrouter.ai/settings/credits")
    return 0


def show_aliases() -> int:
    width = max(map(len, MODEL_ALIASES))
    for alias, model_id in MODEL_ALIASES.items():
        default = "  (default)" if alias == DEFAULT_MODEL else ""
        print(f"{alias:<{width}}  ->  {model_id}{default}")
    print("\nEdit MODEL_ALIASES in openrouter_studio/client.py to add your own.")
    return 0


def list_models(text: str) -> int:
    models = [m for m in fetch_models()
              if text.lower() in (m["id"] + " " + m.get("name", "")).lower()]
    for m in sorted(models, key=lambda m: m["id"]):
        price = m.get("pricing", {})
        try:
            cost = f"${float(price['prompt']) * 1e6:.2f} in / ${float(price['completion']) * 1e6:.2f} out per 1M tokens"
        except (KeyError, ValueError, TypeError):
            cost = ""
        if cost and float(price["prompt"]) < 0:
            cost = "price varies (router model)"
        print(f"{m['id']:<55} ctx={m.get('context_length') or '?':<8} {cost}")
    info(f"\n{len(models)} model(s).")
    return 0


def read_input(args: argparse.Namespace) -> str:
    parts = []
    if args.prompt:
        parts.append(args.prompt)
    if args.input == "-":
        parts.append(sys.stdin.read())
    elif args.input:
        parts.append(Path(args.input).read_text(encoding="utf-8"))
    elif not args.prompt and not sys.stdin.isatty():
        parts.append(sys.stdin.read())
    return "\n\n".join(p.strip() for p in parts if p.strip())


def print_usage(client: OpenRouterClient) -> None:
    usage = client.last_usage or {}
    cost = f", cost ${usage['cost']:.6f}" if usage.get("cost") is not None else ""
    info(f"[{client.last_model}] tokens: {usage.get('prompt_tokens', '?')} in, "
         f"{usage.get('completion_tokens', '?')} out{cost}")


def run_once(client: OpenRouterClient, models: list[str], prompt: str,
             args: argparse.Namespace, params: dict) -> int:
    stream = not args.no_stream and not args.output
    results, failed = [], 0

    for model in models:
        header = f"===== {model} ({resolve_model(model)}) =====" if len(models) > 1 else ""
        if header and not args.output:
            print(header)
        try:
            if stream:
                answer = ""
                for piece in client.ask_stream(prompt, model=model, system=args.system, **params):
                    print(piece, end="", flush=True)
                    answer += piece
                print()
            else:
                if args.output:
                    info(f"Asking {resolve_model(model)} ...")
                answer = client.ask(prompt, model=model, system=args.system, **params)
                if not args.output:
                    print(answer)
        except (OpenRouterError, requests.RequestException) as e:
            if stream:
                print()
            info(f"Error from {model}: {e}")
            failed += 1
            answer = f"[error] {e}"
        if args.verbose:
            print_usage(client)
        if len(models) > 1 and not args.output:
            print()
        results.append(f"{header}\n{answer}" if header else answer)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text("\n\n".join(results) + "\n", encoding="utf-8")
        info(f"Answer saved to {args.output}")
    return 1 if failed == len(models) else 0


def chat_loop(client: OpenRouterClient, model: str, args: argparse.Namespace, params: dict) -> int:
    system = [{"role": "system", "content": args.system}] if args.system else []
    messages = list(system)
    print(f"Chatting with {model} ({resolve_model(model)}).")
    print("Commands: /model NAME  switch model | /clear  forget history | /exit  quit")

    while True:
        try:
            user = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not user:
            continue
        if user in ("/exit", "/quit"):
            return 0
        if user == "/clear":
            messages = list(system)
            print("History cleared.")
            continue
        if user == "/model" or user.startswith("/model "):
            parts = user.split(maxsplit=1)
            if len(parts) == 2:
                model = parts[1]
            print(f"Model: {model} ({resolve_model(model)})")
            continue

        messages.append({"role": "user", "content": user})
        print(f"\n{model}> ", end="", flush=True)
        reply = ""
        try:
            for piece in client.chat_stream(messages, model=model, **params):
                print(piece, end="", flush=True)
                reply += piece
            print()
        except (OpenRouterError, requests.RequestException, KeyboardInterrupt) as e:
            print(f"\n[{'stopped' if isinstance(e, KeyboardInterrupt) else f'error: {e}'}]")
            messages.pop()  # drop the unanswered question so history stays valid
            continue
        messages.append({"role": "assistant", "content": reply})
        if args.verbose:
            print_usage(client)


def main() -> int:
    """Entry point (also used by the installed `openrouter` command)."""
    try:
        return _main()
    except OpenRouterError as e:
        info(f"Error: {e}")
        return 1
    except requests.RequestException as e:
        info(f"Network error: {e}")
        return 1
    except OSError as e:  # e.g. -i points to a missing file
        info(f"Error: {e}")
        return 1
    except KeyboardInterrupt:
        return 130


def _main() -> int:
    args = parse_args()

    if args.setup:
        return setup()
    if args.aliases:
        return show_aliases()
    if args.usage:
        return show_usage()
    if args.list_models is not None:
        return list_models(args.list_models)

    models = [m.strip() for m in args.model.split(",") if m.strip()]
    params = {"temperature": args.temperature, "max_tokens": args.max_tokens}
    client = OpenRouterClient()

    if args.chat:
        return chat_loop(client, models[0], args, params)

    prompt = read_input(args)
    if not prompt:
        info('No input. Give a prompt, e.g.  openrouter "Hello"  (see -h for more).')
        return 2
    return run_once(client, models, prompt, args, params)


if __name__ == "__main__":
    sys.exit(main())
