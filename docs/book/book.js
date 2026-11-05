/* The Trustwork Book: reading progress, where you are, the theme switch.
 * Everything here is a convenience; the book reads whole without it. */
/* global window, document */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.remove("no-js");

  /* Theme: follow the system until the reader chooses; remember the choice. */
  var button = document.querySelector(".theme");
  function storedTheme() {
    try {
      return window.localStorage.getItem("trustwork-book-theme");
    } catch {
      return null;
    }
  }
  var stored = storedTheme();
  if (stored === "light" || stored === "dark")
    root.setAttribute("data-theme", stored);
  function isDark() {
    var set = root.getAttribute("data-theme");
    if (set) return set === "dark";
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }
  function paint() {
    if (!button) return;
    button.textContent = isDark() ? "☀" : "☾";
    button.setAttribute(
      "aria-label",
      isDark() ? "Switch to the light theme" : "Switch to the dark theme",
    );
  }
  if (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        window.localStorage.setItem("trustwork-book-theme", next);
      } catch {
        /* a private window keeps the choice for this page only */
      }
      paint();
    });
    paint();
  }

  /* Progress and the chapter you are in. */
  var bar = document.querySelector(".progress .bar");
  var where = document.querySelector(".where");
  var chapters = Array.prototype.slice.call(
    document.querySelectorAll(".chapter"),
  );
  var ticking = false;
  function update() {
    ticking = false;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var read = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    if (bar) bar.style.transform = "scaleX(" + read.toFixed(4) + ")";
    if (where) {
      var line = window.scrollY + 80;
      var current = null;
      for (var i = 0; i < chapters.length; i++) {
        if (chapters[i].offsetTop <= line) current = chapters[i];
      }
      var text = current
        ? current.getAttribute("data-chapter") +
          " · " +
          current.getAttribute("data-title")
        : "";
      if (where.textContent !== text) where.textContent = text;
    }
  }
  function onScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();

  /* A tapped section heading copies nothing and opens nothing: the ¶ is a link. */
})();
