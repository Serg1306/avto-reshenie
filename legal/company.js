// Реквизиты ООО — единственное место, где их нужно менять.
// Пустое поле показывается на сайте как «уточняется».
window.COMPANY = {
  name: "ООО «ЦИФРА И РЕШЕНИЕ»",
  inn: "6684050640",
  ogrn: "1269600036452",
  kpp: "668401001",
  addr: "623107, Свердловская обл., Первоуральск м.о., г. Первоуральск, пер. Серова, д. 14",          // юридический адрес
  director: "",      // ФИО генерального директора
  email: "b1.u@bk.ru",
  phone: "",
  bank: "",          // р/с, банк, БИК, к/с
  rkn: "",           // номер в реестре операторов ПДн Роскомнадзора
  ofd: "",           // оператор фискальных данных
  site: "https://serg1306.github.io/avto-reshenie/",
  date: "12.11.2026",// дата редакции документов
  price: "указана на странице оплаты перед покупкой",
  free: "3 (три)",
  paid: "указанное на странице оплаты количество"
};
(function () {
  function fill() {
    var C = window.COMPANY;
    document.querySelectorAll("[data-co]").forEach(function (el) {
      var k = el.getAttribute("data-co"), v = C[k];
      if (v) {
        if (k === "email") el.innerHTML = '<a href="mailto:' + v + '">' + v + "</a>";
        else if (k === "phone") el.innerHTML = '<a href="tel:' + v.replace(/[^+\d]/g, "") + '">' + v + "</a>";
        else el.textContent = v;
      } else { el.textContent = "уточняется"; el.classList.add("co-todo"); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
})();
