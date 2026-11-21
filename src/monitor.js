import { chromium } from "playwright"

import {
  TELEGRAM_API,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_UPDATE_CHAT_TITLE,
  OUTAGE_ICON,
  TITLE_TEXT_START,
  REGION,
  CITY,
  STREET,
  HOUSE,
  TARGET,
  ADDRESS,
  SHUTDOWNS_PAGE,
  RETRIES_MAX_COUNT,
  RETRIES_TIMEOUT,
} from "./constants.js"

import {
  capitalize,
  checkIsNight,
  deleteLastMessage,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
} from "./helpers.js"

import fs from "node:fs"

let getInfoRetries = 0
let sendNotificationRetries = 0

async function getInfo() {
  console.log("🌀 Getting info...")

  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const csrfTokenTag = await browserPage.waitForSelector(
      'meta[name="csrf-token"]',
      { state: "attached" }
    )
    const csrfToken = await csrfTokenTag.getAttribute("content")

    const info = await browserPage.evaluate(
      async ({ REGION, CITY, STREET, csrfToken }) => {
        const formData = new URLSearchParams()
        formData.append("method", "getHomeNum")

        if (REGION !== "k") {
          formData.append("data[0][name]", "city")
          formData.append("data[0][value]", CITY)
        }

        formData.append("data[1][name]", "street")
        formData.append("data[1][value]", STREET)
        formData.append("data[2][name]", "updateFact")
        formData.append("data[2][value]", new Date().toLocaleString("uk-UA"))

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": csrfToken,
          },
          body: formData,
        })
        return await response.json()
      },
      { REGION, CITY, STREET, csrfToken }
    )

    if (!info?.data) throw Error("power outage info missed")

    // графік відключень, який сайт вбудовує у сторінку
    const fact = await browserPage.evaluate(
      () => window.DisconSchedule?.fact ?? null
    );
      
    console.log("✅ Getting info finished.")
        return { ...info, fact };
  } catch (error) {
    console.error(`❌ Getting info failed: ${error.message}.`)
  } finally {
    await browser.close()
  }

  if (getInfoRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting info again...")
    await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
    getInfoRetries++
    return await getInfo()
  }

  throw Error(`❌ Getting info failed after ${RETRIES_MAX_COUNT} retries.`)
}

function checkIsOutage(info) {
  console.log("🌀 Checking power outage...")

  const house = info.data[HOUSE]
  if (!house) throw Error(`❌ House ${HOUSE} not found.`)

  const { sub_type, start_date, end_date, type } = house
  const isOutageDetected =
    sub_type !== "" || start_date !== "" || end_date !== "" || type !== ""

  isOutageDetected
    ? console.log("🚨 Power outage detected!")
    : console.log("⚡️ No power outage!")

  return isOutageDetected
}

function checkIsScheduled(info) {
  console.log("🌀 Checking whether power outage scheduled...")

  const { sub_type } = info?.data?.[HOUSE] || {}
  const isScheduled =
    !sub_type.toLowerCase().includes("авар") &&
    !sub_type.toLowerCase().includes("екст")

  isScheduled
    ? console.log("🗓️ Power outage scheduled!")
    : console.log("⚠️ Power outage not scheduled!")

  return isScheduled
}

function generateOutageText(info) {
  const { sub_type, start_date, end_date } = info?.data?.[HOUSE] || {}

  const reason = capitalize(sub_type)
  const begin = start_date.split(" ")[0]
  const end = end_date.split(" ")[0]

  const outageText = [
    `🪫 <code>${begin} — ${end}</code>`,
    "",
    `⚠️ <i>${reason}.</i>`,
  ].join("\n")

  return outageText
}

function generateMessage(info, isOutage) {
  console.log("🌀 Generating message...")

  const { updateTimestamp } = info || {}
  const update = updateTimestamp?.split(" ").reverse().join(" ")

  const title = isOutage
    ? "⚡️ <b>Зафіксовано позапланове відключення:</b>"
    : "⚡️ <b>Позапланове відключення завершено</b>"
  const outageText = isOutage ? generateOutageText(info) : undefined

  const text = [
    title,
    TARGET ? `📍 ${ADDRESS}` : undefined,
    outageText,
    "",
    `📢 <i>${update}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  return { text, outageText }
}

async function updateChatTitle(isOutage) {
  if (!TELEGRAM_UPDATE_CHAT_TITLE || TARGET) return

  try {
    const chat = await fetch(
      `${TELEGRAM_API}/getChat?chat_id=${TELEGRAM_CHAT_ID}`
    )
    const { result } = await chat.json()
    if (!result?.title) return

    const title = result.title.replace(`${OUTAGE_ICON} `, "")
    const newTitle = isOutage
      ? title.replace(TITLE_TEXT_START, `${OUTAGE_ICON} `)
      : title

    if (newTitle === result.title) return

    await fetch(`${TELEGRAM_API}/setChatTitle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, title: newTitle }),
    })
  } catch (error) {
    console.error(`❌ Updating chat title failed: ${error.message}.`)
  }
}

const SCHEDULE_FILE = ".last-schedule.json"
// можна задати вручну, якщо група не визначається автоматично, напр. "GPV4.1"
const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP

function loadLastSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"))
  } catch {
    return {}
  }
}

function saveLastSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data))
}

const formatMinutes = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

// day: { "1": "yes" | "no" | "maybe" | "first" | "second" | "mfirst" | "msecond", ... "24": ... }
// "1" = 00:00–01:00, ..., "24" = 23:00–24:00
function dayToIntervals(day) {
  // 48 півгодинних слотів: 0 — є світло, 1 — немає, 2 — можливе відключення
  const slots = new Array(48).fill(0)

  for (let hour = 1; hour <= 24; hour++) {
    const i = (hour - 1) * 2
    switch (day?.[hour]) {
      case "no":
        slots[i] = slots[i + 1] = 1
        break
      case "first":
        slots[i] = 1
        break
      case "second":
        slots[i + 1] = 1
        break
      case "maybe":
        slots[i] = slots[i + 1] = 2
        break
      case "mfirst":
        slots[i] = 2
        break
      case "msecond":
        slots[i + 1] = 2
        break
    }
  }

  const intervals = []
  let start = 0
  for (let i = 1; i <= 48; i++) {
    if (i === 48 || slots[i] !== slots[start]) {
      if (slots[start] !== 0) {
        intervals.push({
          type: slots[start],
          from: formatMinutes(start * 30),
          to: formatMinutes(i * 30),
        })
      }
      start = i
    }
  }
  return intervals
}

function generateScheduleText(info) {
  const fact = info?.fact
  if (!fact?.data) return null

  const group = SCHEDULE_GROUP || info?.data?.[HOUSE]?.sub_type_reason?.[0]
  if (!group) return null

  const todayTs = Number(fact.today)
  const days = [
    { label: "Сьогодні", ts: todayTs },
    { label: "Завтра", ts: todayTs + 86400 },
  ]

  const blocks = []
  for (const { label, ts } of days) {
    const day = fact.data[String(ts)]?.[group]
    if (!day) continue

    const date = new Date(ts * 1000).toLocaleDateString("uk-UA", {
      timeZone: "Europe/Kyiv",
      day: "2-digit",
      month: "2-digit",
    })
    const intervals = dayToIntervals(day)

    blocks.push(
      [
        `📅 <b>${label} (${date}):</b>`,
        ...(intervals.length
          ? intervals.map(
              ({ type, from, to }) =>
                `${type === 1 ? "🪫" : "❓"} <code>${from} — ${to}</code>`
            )
          : ["💡 Відключень не заплановано"]),
      ].join("\n")
    )
  }

  if (!blocks.length) return null

  return [
    "🗓️ <b>Графік відключень</b>",
    TARGET ? `📍 ${ADDRESS}` : undefined,
    `👥 Група: <code>${group}</code>`,
    "",
    blocks.join("\n\n"),
    "",
    `📢 <i>${fact.update ?? ""}</i>`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

async function sendSchedule(info) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  console.log("🌀 Checking schedule...")

  const text = generateScheduleText(info)
  if (!text) {
    console.log("🟡 Schedule not found.")
    return
  }

  // порівнюємо без рядка "оновлено", щоб не слати дублікати
  const signature = text.replace(/📢.*$/s, "")
  const last = loadLastSchedule()
  if (last.signature === signature) {
    console.log("🟡 Schedule not changed.")
    return
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_notification: checkIsNight(),
        reply_parameters: last.message_id
          ? {
              message_id: last.message_id,
              allow_sending_without_reply: true,
            }
          : undefined,
      }),
    })
    const data = await response.json()
    if (!data.ok) throw Error(data.description)

    saveLastSchedule({ message_id: data.result.message_id, signature })
    console.log("🟢 Schedule sent.")
  } catch (error) {
    // збій графіка не має ламати моніторинг аварійних відключень
    console.error(`❌ Sending schedule failed: ${error.message}.`)
  }
}


async function sendNotification({ text, outageText }) {
  if (!TELEGRAM_BOT_TOKEN) throw Error("❌ Missing telegram bot token.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessage() || {}
  const isOutageChanged = lastMessage.outageText !== outageText
  const isEdit = Boolean(lastMessage.message_id) && !isOutageChanged
  const isReply = Boolean(lastMessage.message_id) && isOutageChanged

  try {
    const response = await fetch(
      `${TELEGRAM_API}/${isEdit ? "editMessageText" : "sendMessage"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_notification: checkIsNight(),
          message_id: isEdit ? lastMessage.message_id : undefined,
          reply_parameters: isReply
            ? {
                message_id: lastMessage.message_id,
                allow_sending_without_reply: true,
              }
            : undefined,
        }),
      }
    )

    const data = await response.json()

    if (data.description?.includes("not modified")) {
      console.log("🟡 Notification not changed.")
      return
    }
    if (!data.ok) throw Error(data.description)

    saveLastMessage({ ...data.result, outageText })

    console.log("🟢 Notification sent.")
    return
  } catch (error) {
    console.error(`❌ Sending notification failed: ${error.message}.`)

    const isMessageLost =
      /message to edit not found|message can't be edited/i.test(error.message)
    if (isMessageLost) deleteLastMessage()
  }

  if (sendNotificationRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try sending notification again...")
    await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
    sendNotificationRetries++
    return await sendNotification({ text, outageText })
  }

  throw Error(
    `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

async function run() {
  const info = await getInfo()
  const isOutage = checkIsOutage(info) && !checkIsScheduled(info)

  await updateChatTitle(isOutage)
  await sendSchedule(info)

  if (isOutage || loadLastMessage()?.outageText) {
    const message = generateMessage(info, isOutage)
    await sendNotification(message)
  }
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
