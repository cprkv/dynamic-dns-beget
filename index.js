const sa = require("superagent");
const path = require("path");
const winston = require("winston");
require("winston-daily-rotate-file");
const fs = require("fs");

const loggerFormat = winston.format.combine(
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss",
  }),
  winston.format.printf(
    (info) =>
      `${info.timestamp}  ${info.level}  ${info.message}` +
      (info.splat !== undefined ? `${info.splat}` : " ")
  )
);

const transportRotateFile = new winston.transports.DailyRotateFile({
  filename: path.join(__dirname, "logs", "%DATE%.log"),
  level: "info",
  datePattern: "yyyy-MM-DD",
  maxSize: "20m",
  maxFiles: "3d",
  prepend: true,
});

const logger = winston.createLogger({
  level: "info",
  format: loggerFormat,
  transports: [transportRotateFile, new winston.transports.Console()],
});

let config;
const configPath = path.join(__dirname, ".config.json");

try {
  config = require(configPath);
} catch {
  logger.error(`error: no config file. you need to create '${configPath}'`);
  process.exit(1);
}

if (
  !config.login ||
  !config.password ||
  !config.domains ||
  !config.domains.length
) {
  logger.error(
    `error: invalid config file: '${configPath}'. check all fields in it`
  );
  process.exit(1);
}

const { login, password, domains } = config;

runAsync(async () => {
  const ipAddress = await getOutsideIPAddress();
  logger.info(`outside ip address: ${ipAddress}`);

  for (const domain of domains) {
    logger.info(`domain: ${domain}`);

    const currentARecord = await getDomainARecord(domain);
    logger.info(`  current A record: ${currentARecord}`);

    if (currentARecord != ipAddress) {
      logger.info(`  updating to new A record: '${ipAddress}'`);
      await updateDomainARecord(domain, ipAddress);
    } else {
      logger.info(`  nothing to update`);
    }
  }

  logger.info("all records updated successfully");
});

function runAsync(func) {
  func().catch((e) => {
    logger.error(e);
    process.exit(1);
  });
}

async function getOutsideIPAddress() {
  const res = await sa.get("http://ident.me");
  if (!res.ok) {
    throw new Error("error getting outside ip address");
  }
  if (res.headers["content-type"] != "text/plain") {
    throw new Error("unknown content type for getting outside ip address");
  }
  if (!res.text.match(/^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/)) {
    throw new Error(`outside ip address '${res.text}' is invalid`);
  }
  return res.text;
}

async function updateDomainARecord(domain, newARecord) {
  const domainData = {
    fqdn: domain,
    records: { A: [{ priority: 10, value: newARecord }] },
  };
  const res = await sa
    .get("https://api.beget.com/api/dns/changeRecords")
    .set("Accept", "application/json")
    .query({
      login: login,
      passwd: password,
      input_format: "json",
      output_format: "json",
      input_data: JSON.stringify(domainData),
    });
  apiResponseToJSON(res, "dns/changeRecords");
}

async function getDomainARecord(domain) {
  const res = await sa.get("https://api.beget.com/api/dns/getData").query({
    login: login,
    passwd: password,
    input_format: "json",
    output_format: "json",
    input_data: JSON.stringify({ fqdn: domain }),
  });
  const { result } = apiResponseToJSON(res, "dns/getData");

  if (!result.records.A || result.records.A.length == 0) {
    throw new Error(
      `no A domain record found: ${JSON.stringify(result.records, null, 2)}`
    );
  }

  if (result.records.A.length != 1) {
    throw new Error(
      `domain A record should be exactly one: ${JSON.stringify(
        result.records.A,
        null,
        2
      )}`
    );
  }

  return result.records.A[0].address;
}

function apiResponseToJSON(res, name) {
  if (!res.ok) {
    throw new Error(`error api call ${name}: ${res.text}`);
  }

  const answer = JSON.parse(res.text);

  if (answer.answer && answer.answer.errors && answer.answer.errors.length) {
    console.log(`  api call ${name} errors:`);
    for (const { error_code, error_text } of answer.answer.errors) {
      console.log(`    code: ${error_code}  text: ${error_text}`);
    }
  }

  if (answer.status !== "success" || answer.answer.status !== "success") {
    throw new Error(
      `error api call ${name}: ${JSON.stringify(answer, null, 2)}`
    );
  }

  return answer.answer;
}
