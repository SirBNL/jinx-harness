# 🧠 پرووایدر هوش مصنوعی — راهنمای کامل

Jinx Harness **هیچ پرووایدر پیش‌فرضی ندارد**. هر سرویسی که API سازگار با
**OpenAI Chat Completions** بدهد کار می‌کند — یعنی تقریباً همه‌جا.

## تنظیم سریع (فایل .env)

در `portable/.env` این سه خط را پر کن:

```env
JINX_BASE_URL=https://api.openai.com/v1
JINX_API_KEY=sk-...
JINX_MODEL=gpt-4o-mini
```

فقط همین. بعد Restart.

## جدول پرووایدرهای رایج

| پرووایدر | JINX_BASE_URL | نمونهٔ JINX_MODEL | توضیح |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | مرجع اصلی |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | صدها مدل پشت یک API — مناسب‌ترین گزینهٔ عمومی |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | سریع‌ترین؛ پلن رایگان خوب |
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-chat` | ارزان و قوی برای کد |
| **Together** | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | مدل‌های متن‌باز |
| **Mistral** | `https://api.mistral.ai/v1` | `mistral-large-latest` | |
| **xAI (Grok)** | `https://api.x.ai/v1` | `grok-3-mini` | |
| **Ollama (محلی)** | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | کاملاً آفلاین؛ کلید = `ollama` |
| **LM Studio (محلی)** | `http://127.0.0.1:1234/v1` | نام مدلی که لود کردی | کلید = هرچی |
| **vLLM (سرور خودت)** | `http://your-server:8000/v1` | نام مدل | برای GPU اختصاصی |
| **هر سرویس دیگر** | آدرس `/v1` آن سرویس | — | اگر OpenAI-compatible باشد کار می‌کند |

> **نام‌گذاری قدیمی:** متغیرها `JINX_*` نام دارند (میراث نسخه‌های قبلی)؛
> `JINX_BASE_URL` یعنی «آدرس پرووایدر تو» — نه یک سرویس خاص.

## راه دوم: از پنل مدیریت (بدون دست‌زدن به فایل‌ها)

1. پنل را باز کن: `https://دامنه-تو/admin?t=WEBHOOK_SECRET`
2. بخش **Providers**
3. یک پرووایدر اضافه کن: نام دلخواه + Base URL + کلید + مدل
4. فعالش کن — بدون ری‌استارت

می‌توانی **چند پرووایدر** تعریف کنی و از پنل بین‌شان سوییچ کنی.
اگر در `.env` هم `JINX_FALLBACK_URL/KEY/MODEL` ست کنی، پرووایدر پشتیبان
در قطعیِ پروایدر اصلی خودکار وارد می‌شود.

## کدام مدل را انتخاب کنم؟

ایجنتِ ابزارمحور به مدلی نیاز دارد که **function calling** را خوب بلد است:

- **بودجهٔ خوب:** `gpt-4o` / `claude` (از OpenRouter) / `deepseek-chat`
- **بودجهٔ متوسط:** `gpt-4o-mini` / `deepseek-chat` — بهترین نسبت قیمت/کیفیت برای ایجنت
- **رایگان/محلی:** مدل‌های Groq (پلن رایگان) یا Ollama با `qwen2.5:7b` به بالا

هرچه مدل در function calling ضعیف‌تر باشد، حلقهٔ ابزار کمتر قابل‌اتکا می‌شود.

## چند کلید برای چرخش بار (اختیاری)

```env
JINX_API_KEYS=sk-key1,sk-key2,sk-key3
```

## سؤالات متداول

**پرووایدر ست نکنم چه می‌شود؟**
ربات بوت می‌شود و پنل کار می‌کند، اما به پیام‌های تلگرام پاسخ نمی‌دهد تا
اینکه از پنل یا `.env` یک پرووایدر اضافه کنی.

**مدل من vision دارد؟ چه چیزی فرق می‌کند؟**
عکس و فایل‌هایی که کاربر بفرستد به مدل می‌رسد (قابلیت v9.2)؛ خودِ ربات
خودش را با مدل تطبیق می‌دهد — کاری لازم نیست بکنی.

**پرووایدر من OpenAI-compatible نیست!**
یک لایهٔ سازگار وسط بگذار: [LiteLLM](https://github.com/BerriAI/litellm)
یا Ollama تقریباً هر چیزی را به این فرمت تبدیل می‌کند.
