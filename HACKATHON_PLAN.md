# Hackathon Plan — AI Mafia

## Что уже используем

| Технология | Где в проекте | Статус |
|---|---|---|
| **Gemini Live API** | Game Master нарратор + голосовые AI агенты | ✅ Ключевая |
| **Fishjam** | WebRTC видео/аудио комнаты между игроками | ✅ Ключевая |
| **MediaPipe** | Анализ эмоций лица → нарратор комментирует стресс + паник-эмодзи на видео | ✅ Активировано |
| **Smelter** | Spectator broadcast с GPU шейдерами (grayscale, night, stress pulse) | ✅ apps/broadcast |
| **TypeGPU** | GPU confetti на победу + ночной шейдер-оверлей с vignette и pulse | ✅ widgets/gpu-effects |

---

## Что нужно добавить

### 1. Smelter — видео-композитор реального времени

**Что это:** Software Mansion'овский инструмент для композитинга видеопотоков в реальном времени. Работает с Fishjam.

**Как вписать в AI Mafia:**

- **Ночная фаза** — затемнение видеопотоков всех игроков (dark overlay), только аудио Game Master'а слышно
- **Смерть игрока** — grayscale фильтр на видеопоток убитого + красная рамка мигает при объявлении
- **Голосование** — подсветка рамки подозреваемого (жёлтая), мигание при финальном выборе
- **Role reveal** — цветная рамка по роли (красная = мафия, синяя = детектив, зелёная = доктор)
- **Narrator speaking** — визуальный индикатор "AI speaks" на всех потоках

**Интеграция:**
- Smelter сидит между Fishjam и клиентами
- Сервер отправляет команды в Smelter при смене фаз (`night` → затемнение, `death` → grayscale)
- Выходной композитный поток идёт клиентам вместо сырых Fishjam потоков

**Сложность:** Средняя. Основная работа — настроить Smelter pipeline и связать с GameManager фазами.

---

### 2. TypeGPU — GPU-эффекты на TypeScript

**Что это:** Software Mansion'овская библиотека для GPU-вычислений прямо из TypeScript (WebGPU шейдеры).

**Как вписать в AI Mafia:**

- **Фазовые переходы** — GPU-шейдер для перехода night↔day (плавное затемнение/рассвет эффект на весь экран)
- **Партикл-система** — искры/дым при убийстве, золотой confetti при победе
- **Suspicion heatmap** — визуализация подозрительности игроков как тепловая карта вокруг VideoTile (красный = подозрительный)
- **Audio visualizer** — GPU-визуализация голоса Game Master'а (волновая анимация)
- **Glitch-эффект** — на видео подозреваемого при высоком suspicion score

**Интеграция:**
- TypeGPU canvas оверлей поверх видео-сетки
- GameManager отправляет phase/suspicion данные → клиент рендерит эффекты на GPU
- Шейдеры написаны на TypeScript (WGSL через TypeGPU API)

**Сложность:** Средняя. Партиклы и простые шейдеры делаются быстро.

---

### 3. Antigravity — agentic IDE от Google

**Что это:** НЕ игровой движок. Это AI IDE (форк VS Code с Gemini агентами) для быстрой разработки.

**Как использовать для хакатона:**
- Упомянуть в презентации как инструмент разработки
- "We used Google Antigravity IDE to accelerate development alongside Claude Code"
- Не требует интеграции в код — это dev tool, не runtime библиотека

---

### 4. MediaPipe — АКТИВИРОВАТЬ

**Что уже есть:** `apps/client/src/entities/game/api/face.ts` — полный код для face detection (stress, surprise, happiness, lookingAway).

**Что отключено:** В `handler.ts` case `face_metrics` пустой (`// Face metrics disabled`).

**Что нужно сделать:**

- Включить обработку `face_metrics` на сервере
- Передавать метрики в GameManager → Gemini narrator
- Narrator использует метрики: "I see nervousness on your face, Marcus... care to explain?"
- Показывать stress indicator на VideoTile (маленький бар)
- AI agents учитывают face metrics при голосовании

**Сложность:** Низкая. Код готов, нужно только "подключить провода".

---

## Статус внедрения

| # | Что | Статус |
|---|---|---|
| 1 | MediaPipe — face analysis → narrator + stress emoji | ✅ Готово |
| 2 | Smelter — spectator broadcast с GPU шейдерами | ✅ Готово (apps/broadcast) |
| 3 | TypeGPU — GPU confetti + night shader overlay | ✅ Готово (widgets/gpu-effects) |
| 4 | Antigravity — IDE (не библиотека) | ℹ️ Упомянуть в презентации |

---

## Итоговый стек

| Технология | Роль | Файлы |
|---|---|---|
| **Gemini Live API** | AI Game Master нарратор + AI голосовые агенты | server/gemini/, server/game/ |
| **Fishjam** | WebRTC видео/аудио между игроками | server/fishjam/, client/app/providers |
| **Smelter** | Spectator broadcast — GPU композитинг видеопотоков | apps/broadcast/ |
| **MediaPipe** | Анализ эмоций лица → нарратор комментирует + паник-эмодзи 😰😱 | client/entities/game/api/face.ts |
| **TypeGPU** | GPU confetti на победу + ночной шейдер с vignette/pulse | client/widgets/gpu-effects/ |
| **Antigravity** | Agentic IDE (dev tool, не runtime) | — |

Покрыт ВЕСЬ рекомендуемый стек для Track 2 + Track 3.
