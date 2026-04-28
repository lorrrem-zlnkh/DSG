import fs from "node:fs/promises";
import crypto from "node:crypto";

const urls = [
  "https://dsgners.ru/avito/11995-5-zadach-kotoryie-ux-issledovateli-avito-reshayut-s-pomoschyu-neyrosetey",
  "https://dsgners.ru/b2bdesign/11762-kak-uluchshit-ux-v-1s-ne-perepisyivaya-kod",
  "https://dsgners.ru/theburmistrov/11415-figma-dobavila-effekt-stekla-kak-na-ios-26",
  "https://dsgners.ru/orshakserg/11524-figma-variables-kak-polzovatsya-peremennymi-i-tokenami",
  "https://dsgners.ru/evgeniashamray/11254-kak-ya-proveryayu-ux-formyi-s-pomoschyu-neyroseti",
  "https://dsgners.ru/proddesiign/11330-emotsionalnyiy-ux-na-vseh-etapah-razrabotki-tsifrovogo-produkta-ot-issledovaniy-do-mikrovzaimodeystviy",
  "https://dsgners.ru/proddesiign/11859-evristiki-ux-fundament-dlya-uspeshnogo-tsifrovogo-produkta",
  "https://dsgners.ru/cherkasov_uxui/11804-pochemu-v-interfeysah-so-slojnoy-logikoy-nedostatochno-pokazat-maketyi-v-figma",
  "https://dsgners.ru/na_produkte/11155-5-prichin-pochemu-dizayneru-stoit-idti-rabotat-v-b2b",
  "https://dsgners.ru/theburmistrov/11801-ii-generator-interfeysov-ot-figma-vyishel-v-otkryityiy-dostup",
  "https://dsgners.ru/cherkasov_uxui/11810-pixso-eto-novaya-figma-ili-god-stradaniy",
  "https://dsgners.ru/designslot/11226-11-tehnik-ii-kotoryie-ekonomyat-vremya-produktovomu-dizayneru",
  "https://dsgners.ru/evgeniashamray/11762-kak-uluchshit-ux-v-1s-ne-perepisyivaya-kod",
  "https://dsgners.ru/atwinta/11415-figma-dobavila-effekt-stekla-kak-na-ios-26",
  "https://dsgners.ru/atwinta/11796-teper-steklyannyim-budet-vsjo-apple-vyipustila-beta-versiyu-interfeysa-so-steklom-a-figma-uje-dobavili-etot-instrument-v-svoy-funktsional",
  "https://dsgners.ru/proddesiign/11859-evristiki-ux-fundament-dlya-uspeshnogo-tsifrovogo-produkta",
  "https://dsgners.ru/cherkasov_uxui/11847-lektoriy-dprofile-v-saratove",
  "https://dsgners.ru/azagency.design/11850-sistemnyie-prodaji-v-agentstve-mif-ili-realnost",
  "https://dsgners.ru/avito/11163-kak-ya-delal-testovyie-v-techenie-10-let-chto-ponyal-i-pochemu-oni-ne-ravnyi-vaytbordam",
  "https://dsgners.ru/golfui/42981-vovlechjonnost-nachinaetsya-s-kontenta-ot-statichnogo-sayta-k-jivomu-obscheniyu",
  "https://dsgners.ru/tiho.design/42992-fokus-samyiy-ogranichennyiy-resurs-o-kotorom-pochti-nikto-ne-govorit",
];

const cacheDir = new URL("../.cache/blog/dsgners/", import.meta.url);
await fs.mkdir(cacheDir, { recursive: true });

for (const url of urls) {
  const id = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) {
      console.error("skip", response.status, url);
      continue;
    }
    const html = await response.text();
    await fs.writeFile(new URL(`${id}.html`, cacheDir), html);
    await fs.writeFile(new URL(`${id}.json`, cacheDir), JSON.stringify({ id, url }));
    console.log("ok", id);
  } catch (error) {
    console.error("err", url, error.message);
  }
}
