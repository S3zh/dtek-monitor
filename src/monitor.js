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
import { createHash } from "node:crypto"

let getInfoRetries = 0
let sendNotificationRetries = 0

const SCHEDULE_FILE = "artifacts/.last-schedule.json"

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

    // чекаємо, поки скрипти сайту намалюють фактичний графік
    let factTables = null
    try {
      await fillAddress(browserPage)

      await browserPage.waitForSelector(
        "#discon-fact-tables, .discon-fact-tables",
        { state: "visible", timeout: 15000 }
      )
      await browserPage.waitForTimeout(1000)

      const parts = await captureFactTables(browserPage)

      if (parts.length) {
        factTables = {
          // rel входить у хеш, щоб поява завтрашнього графіка теж вважалась зміною
          text: parts.map((p) => `${p.rel}\n${p.text}`).join("\n---\n"),
          image:
            parts.length === 1
              ? parts[0].image
              : await stitchImages(browser, parts),
          days: parts.length,
        }
      }
    } catch (error) {
      console.log(`🟡 Fact tables not found: ${error.message}`)
    }
    console.log("✅ Getting info finished.")
    return { ...info, factTables }
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

async function closeModal(page) {
  const modal = page.locator("#modal-attention.is-open")

  try {
    await modal.waitFor({ state: "visible", timeout: 5000 })
  } catch {
    return // попапа немає, нічого закривати
  }

  // кнопка закриття всередині діалогу (не оверлей)
  const closeBtn = modal
    .locator(".modal__container .modal__close")
    .first()

  if (await closeBtn.count()) {
    await closeBtn.click()
  } else {
    await page.keyboard.press("Escape")
  }

  await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {})
}

// контейнер із полями форми графіка (а не форма скарг)
const FORM = ".discon-inputs"

async function fillAutocomplete(page, id, value) {
  const scope = page.locator(FORM).first()
  const input = scope.locator(`#${id}`).first()

  await page.waitForFunction(
    ({ form, inputId }) => {
      const root = document.querySelector(form)
      return root && !root.querySelector(`#${inputId}`)?.disabled
    },
    { form: FORM, inputId: id },
    { timeout: 15000 }
  )

  await input.click()
  await input.fill("")
  await input.pressSequentially(value, { delay: 60 })

  const items = scope.locator(`#${id}autocomplete-list > div`)
  await items.first().waitFor({ state: "visible", timeout: 15000 })

  // точний збіг за прихованим value, інакше перший пункт
  const exact = items.filter({
    has: page.locator(`input[type="hidden"][value="${value}"]`),
  })
  const target = (await exact.count()) ? exact.first() : items.first()
  await target.click()
}

async function fillAddress(page) {
  await page.evaluate(() => document.getElementById("modal-attention")?.remove())

  if (REGION !== "k") await fillAutocomplete(page, "city", CITY)
  await fillAutocomplete(page, "street", STREET)
  await fillAutocomplete(page, "house_num", HOUSE)
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

// знімає скриншоти таблиць для кожної дати, на яку вже є графік
async function captureFactTables(page) {
  const container = page.locator(".discon-fact-tables").first()

  const dates = await page
    .locator(".discon-fact .dates .date")
    .evaluateAll((els) =>
      els.map((el) => ({
        rel: el.getAttribute("rel"),
        label: el.innerText.replace(/\s+/g, " ").trim(),
      }))
    )

  const parts = []

  for (const { rel, label } of dates) {
    const table = container.locator(`.discon-fact-table[rel="${rel}"]`)

    // таблиці немає (напр. для завтра є лише .info-tomorrow) — пропускаємо
    if (!(await table.count())) {
      console.log(`🟡 No schedule for "${label}".`)
      continue
    }

    try {
      // перемикаємо вкладку, щоб сайт показав потрібну таблицю
      await page.locator(`.discon-fact .dates .date[rel="${rel}"]`).click()
      await table.first().waitFor({ state: "visible", timeout: 5000 })
      await page.waitForTimeout(500)

      const text = (await table.first().innerText()).trim()
      if (!text) continue

      parts.push({
        rel,
        label,
        text,
        image: await table.first().screenshot({ type: "png" }),
      })
    } catch (error) {
      console.log(`🟡 Schedule "${label}" skipped: ${error.message}`)
    }
  }

  return parts
}

// склеює кілька скриншотів в одну картинку (вертикально, з підписами дат)
async function stitchImages(browser, parts) {
  const page = await browser.newPage()
  try {
    const blocks = parts
      .map(
        (p) => `
        <div style="margin-bottom:16px">
          <div style="font:600 18px sans-serif;margin-bottom:8px">${p.label}</div>
          <img style="display:block" src="data:image/png;base64,${p.image.toString("base64")}">
        </div>`
      )
      .join("")

    await page.setContent(
      `<body style="margin:0;padding:16px;background:#fff;display:inline-block">${blocks}</body>`,
      { waitUntil: "load" }
    )
    await page.waitForFunction(() =>
      [...document.images].every((img) => img.complete)
    )

    return await page.locator("body").screenshot({ type: "png" })
  } finally {
    await page.close()
  }
}

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

async function sendSchedule(info) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  console.log("🌀 Checking schedule...")

  const tables = info.factTables
  if (!tables) {
    console.log("🟡 Schedule not found.")
    return
  }

  const hash = createHash("sha1").update(tables.text).digest("hex")
  const last = loadLastSchedule()
  if (last.hash === hash) {
    console.log("🟡 Schedule not changed.")
    return
  }

  const update = info.updateTimestamp?.split(" ").reverse().join(" ")
  const caption = [
    "🗓️ <b>Графік відключень</b>" + (tables.days > 1 ? " (сьогодні + завтра)" : ""),
    TARGET ? `📍 ${ADDRESS}` : undefined,
    update ? `📢 <i>${update}</i>` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  try {
    const form = new FormData()
    form.append("chat_id", TELEGRAM_CHAT_ID)
    form.append("caption", caption)
    form.append("parse_mode", "HTML")
    form.append("disable_notification", String(checkIsNight()))
    form.append(
      "photo",
      new Blob([tables.image], { type: "image/png" }),
      "schedule.png"
    )
    if (last.message_id) {
      form.append(
        "reply_parameters",
        JSON.stringify({
          message_id: last.message_id,
          allow_sending_without_reply: true,
        })
      )
    }

    const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      body: form,
    })
    const data = await response.json()
    if (!data.ok) throw Error(data.description)

    saveLastSchedule({ message_id: data.result.message_id, hash })
    console.log("🟢 Schedule sent.")
  } catch (error) {
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
