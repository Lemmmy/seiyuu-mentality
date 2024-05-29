// ==UserScript==
// @name         seiyuu mentality
// @namespace    https://lem.sh/
// @version      2024-05-29
// @description  highlights voice actors on anilist if lem is mental about them
// @author       Lemmmy
// @match        https://anilist.co/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=anilist.co
// @grant        GM_log
// ==/UserScript==

// users to track and the colours for them (RGB). preference is given to the first user in the list
const users = {
  "$self": { text: [255, 51, 106], shadow: [171, 1, 47] },
  "Lemmmy": { text: [241, 129, 102], shadow: [229, 98, 67] },
}

const apiUrl = "https://graphql.anilist.co";
const updateThreshold = 1000 * 60 * 60 * 24; // 1 day
const query = `query ($username: String, $page: Int) {
  User (name: $username) {
    name
    avatar {
      large
      medium
    }
    favourites {
      staff (page: $page, perPage: 25) {
        nodes {
          id
          name {
            first
            middle
            last
            full
            native
            userPreferred
          }
          siteUrl
        }
      }
    }
  }
}`;

(function() {
  "use strict";

  // These maps will not handle removals without a refresh or two
  /** Map of staff IDs in general */
  const staffMap = {};
  /** Map of staff IDs to users who like them (Record<string, Set<string>>) */
  const staffIdToUserMap = {};

  let observer = null;

  const lsGetKey = key => `seiyuu-mentality:${key}`;
  function lsGetString(key, defaultValue) {
    const value = localStorage.getItem(lsGetKey(key));
    return value !== null ? value : defaultValue;
  }
  function lsSetString(key, value) {
    const k = lsGetKey(key);
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(lsGetKey(key), value);
  }
  function lsGetObject(key) {
    const value = lsGetString(key);
    if (!value || value === "undefined") return undefined;
    return JSON.parse(value);
  }
  function lsSetObject(key, value) {
    if (value === undefined || value === null) lsSetString(key, null);
    else lsSetString(key, JSON.stringify(value));
  }

  async function loadFavouriteStaff(username) {
    const staff = {};
    const ownUsername = username === "$self" ? getOwnUsername() : null;

    let results = 0, page = 1, avatar = null, name = null;
    do {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          query,
          variables: {
            username: ownUsername ?? username,
            page
          }
        })
      });

      const { data } = await res.json();
      if (!data || !data.User) return {};

      const { name, avatar, favourites } = data.User;
      const { nodes } = favourites.staff;

      users[username].name ||= name;
      users[username].avatar ||= avatar.medium;

      for (const node of nodes) {
        staff[node.id] = node;
      }

      results = nodes.length;
      page++;
    } while (results > 0);

    const key = `favouriteStaff:${username}`;
    lsSetString(`${key}:lastUpdate`, new Date().toISOString());
    lsSetString(`${key}:avatar`, users[username].avatar);
    lsSetString(`${key}:name`, users[username].name);
    lsSetObject(key, staff);
    return staff;
  }

  async function getFavouriteStaff(username) {
    const key = `favouriteStaff:${username}`;
    const lastUpdate = lsGetString(`${key}:lastUpdate`);
    const staff = lsGetObject(key);

    if (!staff || !lastUpdate) {
      // Immediately fetch and wait
      GM_log("Fetching favourite staff for", username);
      return await loadFavouriteStaff(username);
    } else if (new Date() - new Date(lastUpdate) > updateThreshold) {
      // Update in the background, but return the cached data
      GM_log("Updating favourite staff for", username);
      loadFavouriteStaff(username)
        .then(() => GM_log("Updated favourite staff for", username))
        .catch(console.error);
    }

    return staff;
  }

  function getOwnUsername() {
    const auth = localStorage.getItem("auth");
    if (!auth) return null;

    const { name } = JSON.parse(auth);
    return name;
  }

  async function loadStaffData() {
    // Load the favourite staff for all users
    for (let username in users) {
      const staff = await getFavouriteStaff(username);

      for (const id in staff) {
        staffMap[id] ||= staff[id];
        staffIdToUserMap[id] ||= new Set();
        staffIdToUserMap[id].add(username);
      }

      const key = `favouriteStaff:${username}`;
      users[username].avatar ||= lsGetString(`${key}:avatar`);
      users[username].name ||= lsGetString(`${key}:name`);
    }

    GM_log("Loaded staff data", users, staffMap, staffIdToUserMap);
  }

  function renderRoleCard($roleCard) {
    // Remove all of our own elements first
    $roleCard.querySelectorAll(".seiyuu-mentality").forEach(e => e.remove());

    // Find the URL and ID of the staff
    const staffUrl = $roleCard.querySelector(".staff a")?.href;
    const [, staffId] = (staffUrl ?? "").match(/\/staff\/(\d+)/) || [];
    if (!staffId) return;

    // Ignore staff nobody likes
    const staffUsers = staffIdToUserMap[staffId];
    if (!staffUsers || staffUsers.size === 0) return;

    const $name = $roleCard.querySelector(".staff .name");
    if (!$name) return;

    try {
      // Find the first user (per users definition order) who likes this staff, to use as the colour
      let user = null;
      for (const u of Object.keys(users)) {
        if (staffUsers.has(u)) {
          user = u;
          break;
        }
      }
      if (!user) {
        GM_log(`Could not find a user for staff ID ${staffId}?!`);
        return;
      }

      // Apply the style to the name
      const { text, shadow } = users[user];
      const [r, g, b] = text;
      const [sr, sg, sb] = shadow;
      $name.style.color = `rgb(${r}, ${g}, ${b})`;
      $name.style.textShadow = `0 3px 8px rgba(${sr}, ${sg}, ${sb}, 0.75)`;
    } catch (e) {
      console.error("seiyuu-mentality: Error rendering role card name", e);
    }

    try {
      // Add the user avatars to the card. If $self maps to the same name as another user, don't add it
      const avatarUsers = new Set();
      for (const u of staffUsers) {
        if (u === "$self" && staffUsers.has(users[u].name)) continue;
        avatarUsers.add(users[u].name);
      }

      const $avatars = document.createElement("div");
      $avatars.className = "seiyuu-mentality";
      $avatars.style.display = "flex";
      $avatars.style.flexWrap = "wrap";
      $avatars.style.alignItems = "center";
      $avatars.style.justifyContent = "flex-end";
      $avatars.style.gap = "2px";
      $avatars.style.marginTop = "2px";
      $avatars.style.marginBottom = "2px";

      for (const u of avatarUsers) {
        const $avatar = document.createElement("img");
        $avatar.src = users[u].avatar;
        $avatar.title = u;
        $avatar.alt = u;
        $avatar.style.width = "15px";
        $avatar.style.height = "15px";
        $avatar.style.borderRadius = "2px";
        $avatars.appendChild($avatar);
      }

      const $content = $roleCard.querySelector(".staff .content");
      $content.style.display = "flex";
      $content.style.flexDirection = "column";
      $name.style.flex = "1";
      $name.style.height = "100%";

      const $role = $content.querySelector(".role");
      $role.style.fontSize = "80%";
      $content.insertBefore($avatars, $role);
    } catch (e) {
      console.error("seiyuu-mentality: Error rendering role card avatars", e);
    }
  }

  function initialRender() {
    // Remove any existing observer
    if (observer) observer.disconnect();

    // Observe the DOM for new role cards
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          // Find all role cards and render them
          if (node.classList.contains("role-card")) {
            renderRoleCard(node);
          } else {
            const roleCards = node.querySelectorAll(".role-card");
            for (const roleCard of roleCards) {
              renderRoleCard(roleCard);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Find and render all existing role cards
    const roleCards = document.querySelectorAll(".role-card");
    for (const roleCard of roleCards) {
      renderRoleCard(roleCard);
    }
  }

  function onReady() {
    // Load the staff data in the background
    GM_log("seiyuu-mentality: Loading staff data");
    loadStaffData()
      .then(initialRender)
      .catch(err => {
        console.error("seiyuu-mentality: Error loading staff data", err);
        GM_log("seiyuu-mentality: Error loading staff data", err);
      });
  }

  GM_log("seiyuu-mentality: Init");
  if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
    onReady();
  } else {
    document.addEventListener("DOMContentLoaded", onReady);
  }
})();
