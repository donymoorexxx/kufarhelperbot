// Каталог категорий и регионов для Mini App.
// path — часть адреса kufar.by/l/<регион>/<path>. Если какая-то категория не открывается,
// достаточно поправить её path здесь. Проверка всех адресов: /api/diag?key=<WEBHOOK_SECRET>

export const CATEGORIES = [
  { id: "phones", name: "Телефоны", icon: "📱", group: "Электроника", path: "telefony" },
  { id: "laptops", name: "Ноутбуки", icon: "💻", group: "Электроника", path: "noutbuki" },
  { id: "tablets", name: "Планшеты", icon: "📲", group: "Электроника", path: "planshety" },
  { id: "computers", name: "Компьютерная техника", icon: "🖥️", group: "Электроника", path: "kompyuternaya-tehnika" },
  { id: "tv", name: "Телевизоры", icon: "📺", group: "Электроника", path: "televizory" },
  { id: "games", name: "Игры и приставки", icon: "🎮", group: "Электроника", path: "igry-i-pristavki" },
  { id: "appliances", name: "Бытовая техника", icon: "🧺", group: "Электроника", path: "bytovaya-tehnika" },

  { id: "furniture", name: "Мебель", icon: "🛋️", group: "Дом", path: "mebel" },
  { id: "home", name: "Для дома и дачи", icon: "🏡", group: "Дом", path: "dlya-doma-i-dachi" },
  { id: "repair", name: "Ремонт и стройка", icon: "🧱", group: "Дом", path: "remont-i-stroitelstvo" },

  { id: "women", name: "Женская одежда", icon: "👗", group: "Одежда и обувь", path: "zhenskaya-odezhda" },
  { id: "men", name: "Мужская одежда", icon: "👕", group: "Одежда и обувь", path: "muzhskaya-odezhda" },
  { id: "shoes", name: "Обувь", icon: "👟", group: "Одежда и обувь", path: "obuv" },
  { id: "kids", name: "Товары для детей", icon: "🧸", group: "Одежда и обувь", path: "tovary-dlya-detej" },

  { id: "cars", name: "Автомобили", icon: "🚗", group: "Авто", path: "avtomobili" },
  { id: "parts", name: "Автозапчасти", icon: "🔧", group: "Авто", path: "avtozapchasti" },
  { id: "tires", name: "Шины и диски", icon: "🛞", group: "Авто", path: "shiny-i-diski" },
  { id: "moto", name: "Мототехника", icon: "🏍️", group: "Авто", path: "motocikly" },

  { id: "bikes", name: "Велосипеды", icon: "🚲", group: "Хобби и спорт", path: "velosipedy" },
  { id: "sport", name: "Спорт и отдых", icon: "⚽", group: "Хобби и спорт", path: "sport-i-otdyh" },
  { id: "music", name: "Музыкальные инструменты", icon: "🎸", group: "Хобби и спорт", path: "muzykalnye-instrumenty" },
  { id: "books", name: "Книги", icon: "📚", group: "Хобби и спорт", path: "knigi" },

  { id: "pets", name: "Животные", icon: "🐶", group: "Другое", path: "zhivotnye" },
  { id: "flats", name: "Квартиры", icon: "🏢", group: "Другое", path: "kvartiry" },
  { id: "jobs", name: "Работа", icon: "💼", group: "Другое", path: "rabota" },
  { id: "services", name: "Услуги", icon: "🛠️", group: "Другое", path: "uslugi" },
];

export const REGIONS = [
  { id: "all", name: "Вся Беларусь", path: "" },
  { id: "minsk", name: "Минск", path: "r~minsk" },
  { id: "brest", name: "Брест", path: "r~brest" },
  { id: "vitebsk", name: "Витебск", path: "r~vitebsk" },
  { id: "gomel", name: "Гомель", path: "r~gomel" },
  { id: "grodno", name: "Гродно", path: "r~grodno" },
  { id: "mogilev", name: "Могилёв", path: "r~mogilev" },
];

export function buildUrl(cat, region) {
  return `https://www.kufar.by/l/${region.path ? region.path + "/" : ""}${cat.path}`;
}
