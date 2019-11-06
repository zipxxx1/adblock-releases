
'use strict';

/* For ESLint: List any global identifiers used in this file below */
/* global chrome, require, chromeStorageSetHelper, log, License, translate,
   gabQuestion, ext, getSettings, parseUri, sessionStorageGet, setSetting,
  blockCounts, sessionStorageSet, updateButtonUIAndContextMenus, settings */

const { Filter } = require('filterClasses');
const { WhitelistFilter } = require('filterClasses');
const { checkWhitelisted } = require('whitelisting');
const { Subscription } = require('subscriptionClasses');
const { DownloadableSubscription } = require('subscriptionClasses');
const { SpecialSubscription } = require('subscriptionClasses');
const { filterStorage } = require('filterStorage');
const { filterNotifier } = require('filterNotifier');
const { Prefs } = require('prefs');
const { synchronizer } = require('synchronizer');
const { Utils } = require('utils');
const { getBlockedPerPage } = require('stats');
const NotificationStorage = require('notification').Notification;
const { RegExpFilter, InvalidFilter } = require('filterClasses');
const { URLRequest } = require('../adblockpluschrome/adblockpluscore/lib/url.js');
const info = require('../buildtools/info');

// Object's used on the option, pop up, etc. pages...
const { STATS } = require('./stats');
const { SyncService } = require('./picreplacement/sync-service');
const { DataCollectionV2 } = require('./datacollection.v2');
const { LocalCDN } = require('./localcdn');
const { ServerMessages } = require('./servermessages');
const { recommendations } = require('./alias/recommendations');
const { uninstallInit } = require('./alias/uninstall');
const { ExcludeFilter } = require('./excludefilter');
const {
  recordGeneralMessage,
  recordErrorMessage,
  recordAdreportMessage,
} = require('./servermessages').ServerMessages;
const {
  getUrlFromId,
  unsubscribe,
  getSubscriptionsMinusText,
  getAllSubscriptionsMinusText,
  getIdFromURL,
  getSubscriptionInfoFromURL,
  isLanguageSpecific,
} = require('./adpsubscriptionadapter').SubscriptionAdapter;

Object.assign(window, {
  filterStorage,
  filterNotifier,
  Prefs,
  synchronizer,
  NotificationStorage,
  Subscription,
  SpecialSubscription,
  DownloadableSubscription,
  Filter,
  WhitelistFilter,
  checkWhitelisted,
  info,
  getBlockedPerPage,
  Utils,
  STATS,
  SyncService,
  DataCollectionV2,
  LocalCDN,
  ServerMessages,
  recordGeneralMessage,
  recordErrorMessage,
  recordAdreportMessage,
  getUrlFromId,
  unsubscribe,
  recommendations,
  getSubscriptionsMinusText,
  getAllSubscriptionsMinusText,
  getIdFromURL,
  getSubscriptionInfoFromURL,
  ExcludeFilter,
});

// CUSTOM FILTERS

const isSelectorFilter = function (text) {
  // This returns true for both hiding rules as hiding whitelist rules
  // This means that you'll first have to check if something is an excluded rule
  // before checking this, if the difference matters.
  return /#@?#./.test(text);
};

// custom filter countCache singleton.
const countCache = (function countCache() {
  let cache;

  // Update custom filter count stored in localStorage
  const updateCustomFilterCount = function () {
    chromeStorageSetHelper('custom_filter_count', cache);
  };

  return {
    // Update custom filter count cache and value stored in localStorage.
    // Inputs: new_count_map:count map - count map to replace existing count
    // cache
    updateCustomFilterCountMap(newCountMap) {
      cache = newCountMap || cache;
      updateCustomFilterCount();
    },

    // Remove custom filter count for host
    // Inputs: host:string - url of the host
    removeCustomFilterCount(host) {
      if (host && cache[host]) {
        delete cache[host];
        updateCustomFilterCount();
      }
    },

    // Get current custom filter count for a particular domain
    // Inputs: host:string - url of the host
    getCustomFilterCount(host) {
      return cache[host] || 0;
    },

    // Add 1 to custom filter count for the filters domain.
    // Inputs: filter:string - line of text to be added to custom filters.
    addCustomFilterCount(filter) {
      const host = filter.split('##')[0];
      cache[host] = this.getCustomFilterCount(host) + 1;
      updateCustomFilterCount();
    },

    init() {
      chrome.storage.local.get('custom_filter_count').then((response) => {
        cache = response.custom_filter_count || {};
      });
    },
  };
}());

countCache.init();

// Add a new custom filter entry.
// Inputs: filter:string line of text to add to custom filters.
// Returns: null if succesfull, otherwise an exception
const addCustomFilter = function (filterText) {
  try {
    const filter = Filter.fromText(filterText);
    filterStorage.addFilter(filter);
    if (isSelectorFilter(filterText)) {
      countCache.addCustomFilterCount(filterText);
    }

    return null;
  } catch (ex) {
    // convert to a string so that Safari can pass
    // it back to content scripts
    return ex.toString();
  }
};

// Creates a custom filter entry that whitelists a given page
// Inputs: pageUrl:string url of the page
// Returns: null if successful, otherwise an exception
const createPageWhitelistFilter = function (pageUrl) {
  const url = pageUrl.replace(/#.*$/, ''); // Remove anchors
  const parts = url.match(/^([^?]+)(\??)/); // Detect querystring
  const hasQuerystring = parts[2];
  const filter = `@@|${parts[1]}${hasQuerystring ? '?' : '|'}$document`;
  return addCustomFilter(filter);
};

// UNWHITELISTING

function getUserFilters() {
  const filters = [];

  for (const subscription of filterStorage.subscriptions()) {
    if ((subscription instanceof SpecialSubscription)) {
      for (let j = 0; j < subscription._filterText.length; j++) {
        const filter = subscription._filterText[j];
        filters.push(filter);
      }
    }
  }
  return filters;
}


const isWhitelistFilter = function (text) {
  return /^@@/.test(text);
};

// Look for a custom filter that would whitelist the 'url' parameter
// and if any exist, remove the first one.
// Inputs: url:string - a URL that may be whitelisted by a custom filter
// Returns: true if a filter was found and removed; false otherwise.
const tryToUnwhitelist = function (pageUrl) {
  const url = pageUrl.replace(/#.*$/, ''); // Whitelist ignores anchors
  const customFilters = getUserFilters();
  if (!customFilters || !customFilters.length === 0) {
    return false;
  }

  for (let i = 0; i < customFilters.length; i++) {
    const text = customFilters[i];
    const whitelist = text.search(/@@\*\$document,domain=~/);

    // Blacklist site, which is whitelisted by global @@*&document,domain=~
    // filter
    if (whitelist > -1) {
      // Remove protocols
      const [finalUrl] = url.replace(/((http|https):\/\/)?(www.)?/, '').split(/[/?#]/);
      const oldFilter = Filter.fromText(text);
      filterStorage.removeFilter(oldFilter);
      const newFilter = Filter.fromText(`${text}|~${finalUrl}`);
      filterStorage.addFilter(newFilter);
      return true;
    }

    if (isWhitelistFilter(text)) {
      try {
        const filter = Filter.fromText(text);
        if (filter.matches(URLRequest.from(url), RegExpFilter.typeMap.DOCUMENT, false)) {
          filterStorage.removeFilter(filter);
          return true;
        }
      } catch (ex) {
        // do nothing;
      }
    }
  }
  return false;
};

// Removes a custom filter entry.
// Inputs: host:domain of the custom filters to be reset.
const removeCustomFilter = function (host) {
  const customFilters = getUserFilters();
  if (!customFilters || !customFilters.length === 0) {
    return;
  }

  const identifier = host;

  for (let i = 0; i < customFilters.length; i++) {
    const entry = customFilters[i];

    // If the identifier is at the start of the entry
    // then delete it.
    if (entry.indexOf(identifier) === 0) {
      const filter = Filter.fromText(entry);
      filterStorage.removeFilter(filter);
    }
  }
};

// Entry point for customize.js, used to update custom filter count cache.
const updateCustomFilterCountMap = function (newCountMap) {
  countCache.updateCustomFilterCountMap(newCountMap);
};

const removeCustomFilterForHost = function (host) {
  if (countCache.getCustomFilterCount(host)) {
    removeCustomFilter(host);
    countCache.removeCustomFilterCount(host);
  }
};

const confirmRemovalOfCustomFiltersOnHost = function (host, activeTab) {
  const customFilterCount = countCache.getCustomFilterCount(host);
  const confirmationText = translate('confirm_undo_custom_filters', [customFilterCount, host]);
  // eslint-disable-next-line no-alert
  if (!window.confirm(confirmationText)) {
    return;
  }

  removeCustomFilterForHost(host);
  chrome.tabs.reload(activeTab.id);
};

// Reload already opened tab
// Input:
// id: integer - id of the tab which should be reloaded
const reloadTab = function (id, callback) {
  let tabId = id;
  const localCallback = callback;
  const listener = function (updatedTabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' && tab.status === 'complete') {
      setTimeout(() => {
        chrome.tabs.sendMessage(updatedTabId, { command: 'reloadcomplete' });
        if (typeof localCallback === 'function') {
          localCallback(tab);
        }
        chrome.tabs.onUpdated.removeListener(listener);
      }, 2000);
    }
  };

  if (typeof tabId === 'string') {
    tabId = parseInt(tabId, 10);
  }
  chrome.tabs.onUpdated.addListener(listener);
  chrome.tabs.reload(tabId, { bypassCache: true });
};

const isSelectorExcludeFilter = function (text) {
  return /#@#./.test(text);
};

(function dispatchBGcall() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command !== 'call') {
      return;
    } // not for us

    const fn = window[message.fn];
    if (!fn) {
      // eslint-disable-next-line no-console
      console.log('FN not found, message', message, sender);
    }

    if (message.args && message.args.push) {
      message.args.push(sender);
    }

    const result = fn.apply(window, message.args);
    sendResponse(result);
  });
}());

const getAdblockUserId = function () {
  return STATS.userId();
};

// passthrough functions
const addGABTabListeners = function (sender) {
  gabQuestion.addGABTabListeners(sender);
};

const removeGABTabListeners = function (saveState) {
  gabQuestion.removeGABTabListeners(saveState);
};

// INFO ABOUT CURRENT PAGE

const ytChannelNamePages = new Map();

// Returns true if the url cannot be blocked
const pageIsUnblockable = function (url) {
  if (!url) { // Protect against empty URLs - e.g. Safari empty/bookmarks/top sites page
    return true;
  }
  let scheme = '';
  if (!url.protocol) {
    scheme = parseUri(url).protocol;
  } else {
    scheme = url.protocol;
  }

  return (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'feed:');
};

// Get interesting information about the current tab.
// Inputs:
// callback: function(info).
// info object passed to callback: {
// tab: Tab object
// whitelisted: bool - whether the current tab's URL is whitelisted.
// disabled_site: bool - true if the url is e.g. about:blank or the
// Extension Gallery, where extensions don't run.
// total_blocked: int - # of ads blocked since install
// tab_blocked: int - # of ads blocked on this tab
// display_stats: bool - whether block counts are displayed on button
// display_menu_stats: bool - whether block counts are displayed on the popup
// menu
// }
// Returns: null (asynchronous)
const getCurrentTabInfo = function (callback, secondTime) {
  try {
    chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    }).then((tabs) => {
      try {
        if (tabs.length === 0) {
          return; // For example: only the background devtools or a popup are opened
        }
        const tab = tabs[0];

        if (tab && !tab.url) {
          // Issue 6877: tab URL is not set directly after you opened a window
          // using window.open()
          if (!secondTime) {
            window.setTimeout(() => {
              getCurrentTabInfo(callback, true);
            }, 250);
          }

          return;
        }
        try {
          const page = new ext.Page(tab);
          const disabledSite = pageIsUnblockable(page.url.href);

          const result = {
            page,
            tab,
            disabledSite,
            settings: getSettings(),
          };

          if (!disabledSite) {
            result.whitelisted = checkWhitelisted(page);
          }
          if (
            getSettings().youtube_channel_whitelist
            && parseUri(tab.url).hostname === 'www.youtube.com'
          ) {
            result.youTubeChannelName = ytChannelNamePages.get(page.id);
            // handle the odd occurence of when the  YT Channel Name
            // isn't available in the ytChannelNamePages map
            // obtain the channel name from the URL
            // for instance, when the forward / back button is clicked
            if (!result.youTubeChannelName && /ab_channel/.test(tab.url)) {
              result.youTubeChannelName = parseUri.parseSearch(tab.url).ab_channel;
            }
          }
          callback(result);
        } catch (err) {
          callback({ errorStr: err.toString(), stack: err.stack, message: err.message });
        }
      } catch (err) {
        callback({ errorStr: err.toString(), stack: err.stack, message: err.message });
      }
    });
  } catch (err) {
    callback({ errorStr: err.toString(), stack: err.stack, message: err.message });
  }
};

// Returns true if the page is whitelisted.
// Called from a content script
const pageIsWhitelisted = function (sender) {
  const whitelisted = checkWhitelisted(sender.page);
  return (whitelisted !== undefined && whitelisted !== null);
};

const parseFilter = function (filterText) {
  let filter = null;
  let error = null;
  const text = Filter.normalize(filterText);
  if (text) {
    if (text[0] === '[') {
      error = 'unexpected_filter_list_header';
    } else {
      filter = Filter.fromText(text);
      if (filter instanceof InvalidFilter) {
        error = filter.reason;
      }
    }
  }
  return { filter, error };
};

const pausedKey = 'paused';
// white-list all blocking requests regardless of frame / document, but still allows element hiding
const pausedFilterText1 = '@@';
// white-list all documents, which prevents element hiding
const pausedFilterText2 = '@@*$document';

// Get or set if AdBlock is paused
// Inputs: newValue (optional boolean): if true, AdBlock will be paused, if
// false, AdBlock will not be paused.
// Returns: undefined if newValue was specified, otherwise it returns true
// if paused, false otherwise.
const adblockIsPaused = function (newValue) {
  if (newValue === undefined) {
    return (sessionStorageGet(pausedKey) === true);
  }

  // Add a filter to white list every page.
  const result1 = parseFilter(pausedFilterText1);
  const result2 = parseFilter(pausedFilterText2);
  if (newValue === true) {
    filterStorage.addFilter(result1.filter);
    filterStorage.addFilter(result2.filter);
    chromeStorageSetHelper(pausedKey, true);
  } else {
    filterStorage.removeFilter(result1.filter);
    filterStorage.removeFilter(result2.filter);
    chrome.storage.local.remove(pausedKey);
  }
  sessionStorageSet(pausedKey, newValue);
  return undefined;
};

const domainPausedKey = 'domainPaused';

// Helper that saves the domain pauses
// Inputs:  domainPauses (required object): domain pauses to save
// Returns: undefined
const saveDomainPauses = function (domainPauses) {
  chromeStorageSetHelper(domainPausedKey, domainPauses);
  sessionStorageSet(domainPausedKey, domainPauses);
};

// Helper that removes any domain pause filter rules based on tab events
// Inputs:  tabId (required integer): identifier for the affected tab
//          newDomain (optional string): the current domain of the tab
// Returns: undefined
const domainPauseChangeHelper = function (tabId, newDomain) {
  // get stored domain pauses
  const storedDomainPauses = sessionStorageGet(domainPausedKey);

  // check if any of the stored domain pauses match the affected tab
  for (const aDomain in storedDomainPauses) {
    if (storedDomainPauses[aDomain] === tabId && aDomain !== newDomain) {
      // Remove the filter that white-listed the domain
      const result = parseFilter(`@@${aDomain}$document`);
      filterStorage.removeFilter(result.filter);
      delete storedDomainPauses[aDomain];

      // save updated domain pauses
      saveDomainPauses(storedDomainPauses);
    }
  }
  updateButtonUIAndContextMenus();
};

// Handle the effects of a tab update event on any existing domain pauses
// Inputs:  tabId (required integer): identifier for the affected tab
//          changeInfo (required object with a url property): contains the
// new url for the tab
//          tab (optional Tab object): the affected tab
// Returns: undefined
const domainPauseNavigationHandler = function (tabId, changeInfo) {
  if (changeInfo === undefined || changeInfo.url === undefined || tabId === undefined) {
    return;
  }

  const newDomain = parseUri(changeInfo.url).host;

  domainPauseChangeHelper(tabId, newDomain);
};

// Handle the effects of a tab remove event on any existing domain pauses
// Inputs:  tabId (required integer): identifier for the affected tab
//          changeInfo (optional object): info about the remove event
// Returns: undefined
const domainPauseClosedTabHandler = function (tabId) {
  if (tabId === undefined) {
    return;
  }

  domainPauseChangeHelper(tabId);
};

// Get or set if AdBlock is domain paused for the domain of the specified tab
// Inputs:  activeTab (optional object with url and id properties): the paused tab
//          newValue (optional boolean): if true, AdBlock will be domain paused
// on the tab's domain, if false, AdBlock will not be domain paused on that domain.
// Returns: undefined if activeTab and newValue were specified; otherwise if activeTab
// is specified it returns true if domain paused, false otherwise; finally it returns
// the complete storedDomainPauses if activeTab is not specified

const adblockIsDomainPaused = function (activeTab, newValue) {
  // get stored domain pauses
  let storedDomainPauses = sessionStorageGet(domainPausedKey);

  // return the complete list of stored domain pauses if activeTab is undefined
  if (activeTab === undefined) {
    return storedDomainPauses;
  }

  // return a boolean indicating whether the domain is paused if newValue is undefined
  const activeDomain = parseUri(activeTab.url).host;
  if (newValue === undefined) {
    if (storedDomainPauses) {
      return Object.prototype.hasOwnProperty.call(storedDomainPauses, activeDomain);
    }
    return false;
  }

  // create storedDomainPauses object if needed
  if (!storedDomainPauses) {
    storedDomainPauses = {};
  }

  // set or delete a domain pause
  const result = parseFilter(`@@${activeDomain}$document`);
  if (newValue === true) {
    // add a domain pause
    filterStorage.addFilter(result.filter);
    storedDomainPauses[activeDomain] = activeTab.id;
    chrome.tabs.onUpdated.removeListener(domainPauseNavigationHandler);
    chrome.tabs.onRemoved.removeListener(domainPauseClosedTabHandler);
    chrome.tabs.onUpdated.addListener(domainPauseNavigationHandler);
    chrome.tabs.onRemoved.addListener(domainPauseClosedTabHandler);
  } else {
    // remove the domain pause
    filterStorage.removeFilter(result.filter);
    delete storedDomainPauses[activeDomain];
  }

  // save the updated list of domain pauses
  saveDomainPauses(storedDomainPauses);
  return undefined;
};

// If AdBlock was paused on shutdown (adblock_is_paused is true), then
// unpause / remove the white-list all entry at startup.
chrome.storage.local.get(pausedKey).then((response) => {
  if (response[pausedKey]) {
    const pauseHandler = function () {
      filterNotifier.off('load', pauseHandler);
      const result1 = parseFilter(pausedFilterText1);
      const result2 = parseFilter(pausedFilterText2);
      filterStorage.removeFilter(result1.filter);
      filterStorage.removeFilter(result2.filter);
      chrome.storage.local.remove(pausedKey);
    };

    filterNotifier.on('load', pauseHandler);
  }
});

// If AdBlock was domain paused on shutdown, then unpause / remove
// all domain pause white-list entries at startup.
chrome.storage.local.get(domainPausedKey).then((response) => {
  try {
    const storedDomainPauses = response[domainPausedKey];
    if (!jQuery.isEmptyObject(storedDomainPauses)) {
      const domainPauseHandler = function () {
        filterNotifier.off('load', domainPauseHandler);
        for (const aDomain in storedDomainPauses) {
          const result = parseFilter(`@@${aDomain}$document`);
          filterStorage.removeFilter(result.filter);
        }
        chrome.storage.local.remove(domainPausedKey);
      };
      filterNotifier.on('load', domainPauseHandler);
    }
  } catch (err) {
    // do nothing
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle_pause') {
    adblockIsPaused(!adblockIsPaused());
    recordGeneralMessage('pause_shortcut_used');
  }
});

// Return the contents of a local file.
// Inputs: file:string - the file relative address, eg "js/foo.js".
// Returns: the content of the file.
const readfile = function (file) {
  // A bug in jquery prevents local files from being read, so use XHR.
  const xhr = new XMLHttpRequest();
  xhr.open('GET', chrome.extension.getURL(file), false);
  xhr.send();
  return xhr.responseText;
};

// BETA CODE
if (chrome.runtime.id === 'pljaalgmajnlogcgiohkhdmgpomjcihk') {
  // Display beta page after each update for beta-users only
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update' || details.reason === 'install') {
      chrome.tabs.create({ url: 'https://getadblock.com/beta' });
    }
  });
}

const updateStorageKey = 'last_known_version';
// Commented out only during /update releases
// chrome.runtime.onInstalled.addListener((details) => {
//   if (details.reason === 'update' || details.reason === 'install') {
//     localStorage.setItem(updateStorageKey, chrome.runtime.getManifest().version);
//   }
// });

const openTab = function (url) {
  chrome.tabs.create({ url });
};

if (chrome.runtime.id) {
  let updateTabRetryCount = 0;
  const getUpdatedURL = function () {
    const encodedVersion = encodeURIComponent(chrome.runtime.getManifest().version);
    let updatedURL = `https://getadblock.com/update/${encodedVersion}/?u=${STATS.userId()}`;
    updatedURL = `${updatedURL}&bc=${Prefs.blocked_total}`;
    updatedURL = `${updatedURL}&rt=${updateTabRetryCount}`;
    return updatedURL;
  };
  const waitForUserAction = function () {
    chrome.tabs.onCreated.removeListener(waitForUserAction);
    setTimeout(() => {
      updateTabRetryCount += 1;
      // eslint-disable-next-line no-use-before-define
      openUpdatedPage();
    }, 10000); // 10 seconds
  };
  const openUpdatedPage = function () {
    const updatedURL = getUpdatedURL();
    chrome.tabs.create({ url: updatedURL }).then((tab) => {
      // if we couldn't open a tab to '/updated_tab', send a message
      if (!tab) {
        recordErrorMessage('updated_tab_failed_to_open');
        chrome.tabs.onCreated.removeListener(waitForUserAction);
        chrome.tabs.onCreated.addListener(waitForUserAction);
        return;
      }
      if (updateTabRetryCount > 0) {
        recordGeneralMessage(`updated_tab_retry_success_count_${updateTabRetryCount}`);
      }
    }).catch(() => {
      // if we couldn't open a tab to '/updated_tab', send a message
      recordErrorMessage('updated_tab_failed_to_open');
      chrome.tabs.onCreated.removeListener(waitForUserAction);
      chrome.tabs.onCreated.addListener(waitForUserAction);
    });
  };
  const shouldShowUpdate = function () {
    const checkQueryState = function () {
      chrome.idle.queryState(60, (state) => {
        if (state === 'active') {
          openUpdatedPage();
        } else {
          chrome.tabs.onCreated.removeListener(waitForUserAction);
          chrome.tabs.onCreated.addListener(waitForUserAction);
        }
      });
    };
    if (chrome.management && chrome.management.getSelf) {
      chrome.management.getSelf((extensionInfo) => {
        if (extensionInfo && extensionInfo.installType !== 'admin') {
          checkQueryState();
        } else if (extensionInfo && extensionInfo.installType === 'admin') {
          recordGeneralMessage('update_tab_not_shown_admin_user');
        }
      });
    } else {
      checkQueryState();
    }
  };
  const slashUpdateReleases = ['3.60.0'];
  // Display updated page after each updat
  chrome.runtime.onInstalled.addListener((details) => {
    const lastKnownVersion = localStorage.getItem(updateStorageKey);
    const currentVersion = chrome.runtime.getManifest().version;
    if (
      details.reason === 'update'
      && slashUpdateReleases.includes(currentVersion)
      && !slashUpdateReleases.includes(lastKnownVersion)
      && chrome.runtime.id !== 'pljaalgmajnlogcgiohkhdmgpomjcihk'
    ) {
      STATS.untilLoaded(() => {
        Prefs.untilLoaded.then(shouldShowUpdate);
      });
    }
    localStorage.setItem(updateStorageKey, currentVersion);
  });
}

// Creates a custom filter entry that whitelists a YouTube channel
// Inputs: url:string url of the page
// Returns: null if successful, otherwise an exception
const createWhitelistFilterForYoutubeChannel = function (url) {
  let ytChannel;
  if (/ab_channel=/.test(url)) {
    [, ytChannel] = url.match(/ab_channel=([^]*)/);
  } else {
    ytChannel = url.split('/').pop();
  }
  if (ytChannel) {
    const filter = `@@|https://www.youtube.com/*${ytChannel}|$document`;
    return addCustomFilter(filter);
  }
  return undefined;
};

// YouTube Channel Whitelist and AdBlock Bandaids
const runChannelWhitelist = function (tabUrl, tabId) {
  const isYouTube = parseUri(tabUrl).hostname === 'www.youtube.com';
  const abChannel = parseUri.parseSearch(tabUrl).ab_channel;
  if (isYouTube && getSettings().youtube_channel_whitelist && !abChannel) {
    chrome.tabs.executeScript(tabId,
      {
        file: 'adblock-ytchannel.js',
        runAt: 'document_start',
      });
  }
};

chrome.tabs.onCreated.addListener((tab) => {
  if (chrome.runtime.lastError) {
    return;
  }
  chrome.tabs.get(tab.id).then((tabs) => {
    if (tabs && tabs.url && tabs.id) {
      runChannelWhitelist(tabs.url, tabs.id);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (chrome.runtime.lastError) {
    return;
  }
  if (changeInfo.status === 'loading') {
    if (chrome.runtime.lastError) {
      return;
    }
    chrome.tabs.get(tabId).then((tabs) => {
      if (tabs && tabs.url && tabs.id) {
        runChannelWhitelist(tabs.url, tabs.id);
      }
    });
  }
});

// On single page sites, such as YouTube, that update the URL using the History API pushState(),
// they don't actually load a new page, we need to get notified when this happens
// and update the URLs in the Page and Frame objects
const youTubeHistoryStateUpdateHanlder = function (details) {
  if (details
      && Object.prototype.hasOwnProperty.call(details, 'frameId')
      && Object.prototype.hasOwnProperty.call(details, 'tabId')
      && Object.prototype.hasOwnProperty.call(details, 'url')
      && Object.prototype.hasOwnProperty.call(details, 'transitionType')
      && details.transitionType === 'link') {
    const myURL = new URL(details.url);
    if (myURL.hostname === 'www.youtube.com') {
      const myFrame = ext.getFrame(details.tabId, details.frameId);
      const myPage = ext.getPage(details.tabId);
      const previousWhitelistState = checkWhitelisted(myPage);
      myPage.url = myURL;
      myFrame.url = myURL;
      myFrame._url = myURL;
      const currentWhitelistState = checkWhitelisted(myPage);
      if (!currentWhitelistState && (currentWhitelistState !== previousWhitelistState)) {
        chrome.tabs.sendMessage(details.tabId, { type: 'reloadStyleSheet' });
      }
      if (myURL.pathname === '/') {
        ytChannelNamePages.set(myPage.id, '');
      }
    }
  }
};

const addYouTubeHistoryStateUpdateHanlder = function () {
  chrome.webNavigation.onHistoryStateUpdated.addListener(youTubeHistoryStateUpdateHanlder);
};

const removeYouTubeHistoryStateUpdateHanlder = function () {
  chrome.webNavigation.onHistoryStateUpdated.removeListener(youTubeHistoryStateUpdateHanlder);
};

settings.onload().then(() => {
  if (getSettings().youtube_channel_whitelist) {
    addYouTubeHistoryStateUpdateHanlder();
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!getSettings().youtube_channel_whitelist) {
        return;
      }
      if (ytChannelNamePages.get(tabId) && parseUri(tab.url).hostname !== 'www.youtube.com') {
        ytChannelNamePages.delete(tabId);
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (!getSettings().youtube_channel_whitelist) {
        return;
      }
      ytChannelNamePages.delete(tabId);
    });
  }
});

let previousYTchannelId = '';
let previousYTvideoId = '';
let previousYTuserId = '';

// Listen for the message from the ytchannel.js content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'updateYouTubeChannelName' && message.args === false) {
    ytChannelNamePages.set(sender.tab.id, '');
    sendResponse({});
    return;
  }
  if (message.command === 'updateYouTubeChannelName' && message.channelName) {
    ytChannelNamePages.set(sender.tab.id, message.channelName);
    sendResponse({});
    return;
  }
  if (message.command === 'get_channel_name_by_channel_id' && message.channelId) {
    if (previousYTchannelId !== message.channelId) {
      previousYTchannelId = message.channelId;
      const xhr = new XMLHttpRequest();
      const { channelId } = message;
      const key = atob('QUl6YVN5QzJKMG5lbkhJZ083amZaUUYwaVdaN3BKd3dsMFczdUlz');
      const url = 'https://www.googleapis.com/youtube/v3/channels';
      xhr.open('GET', `${url}?part=snippet&id=${channelId}&key=${key}`);
      xhr.onload = function xhrOnload() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          const json = JSON.parse(xhr.response);
          // Got name of the channel
          if (json && json.items && json.items[0]) {
            const channelName = json.items[0].snippet.title;
            ytChannelNamePages.set(sender.tab.id, channelName);
            chrome.tabs.sendMessage(sender.tab.id, {
              command: 'updateURLWithYouTubeChannelName',
              channelName,
            });
          }
        }
      };
      xhr.send();
      sendResponse({});
      return;
    }
    chrome.tabs.sendMessage(sender.tab.id, {
      command: 'updateURLWithYouTubeChannelName',
      channelName: ytChannelNamePages.get(sender.tab.id),
    });
    sendResponse({});
    return;
  }
  if (message.command === 'get_channel_name_by_video_id' && message.videoId) {
    if (previousYTvideoId !== message.videoId) {
      previousYTvideoId = message.videoId;
      const xhr = new XMLHttpRequest();
      const { videoId } = message;
      const key = atob('QUl6YVN5QzJKMG5lbkhJZ083amZaUUYwaVdaN3BKd3dsMFczdUlz');
      const url = 'https://www.googleapis.com/youtube/v3/videos';
      xhr.open('GET', `${url}?part=snippet&id=${videoId}&key=${key}`);
      xhr.onload = function xhrOnload() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          const json = JSON.parse(xhr.response);
          // Got name of the channel
          if (json && json.items && json.items[0]) {
            const channelName = json.items[0].snippet.channelTitle;
            ytChannelNamePages.set(sender.tab.id, channelName);
            chrome.tabs.sendMessage(sender.tab.id, {
              command: 'updateURLWithYouTubeChannelName',
              channelName,
            });
          }
        }
      };
      xhr.send();
      sendResponse({});
      return;
    }
    chrome.tabs.sendMessage(sender.tab.id, {
      command: 'updateURLWithYouTubeChannelName',
      channelName: ytChannelNamePages.get(sender.tab.id),
    });
    sendResponse({});
    return;
  }
  if (message.command === 'get_channel_name_by_user_id' && message.userId) {
    if (previousYTuserId !== message.userId) {
      previousYTuserId = message.userId;
      const xhr = new XMLHttpRequest();
      const { userId } = message;
      const key = atob('QUl6YVN5QzJKMG5lbkhJZ083amZaUUYwaVdaN3BKd3dsMFczdUlz');
      const url = 'https://www.googleapis.com/youtube/v3/channels';
      xhr.open('GET', `${url}?part=snippet&forUsername=${userId}&key=${key}`);
      xhr.onload = function xhrOnload() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          const json = JSON.parse(xhr.response);
          // Got name of the channel
          if (json && json.items && json.items[0]) {
            const channelName = json.items[0].snippet.title;
            ytChannelNamePages.set(sender.tab.id, channelName);
            chrome.tabs.sendMessage(sender.tab.id, {
              command: 'updateURLWithYouTubeChannelName',
              channelName,
            });
          }
        }
      };
      xhr.send();
      sendResponse({});
    } else {
      chrome.tabs.sendMessage(sender.tab.id, {
        command: 'updateURLWithYouTubeChannelName',
        channelName: ytChannelNamePages.get(sender.tab.id),
      });
      sendResponse({});
    }
  }
});


// These functions are usually only called by content scripts.

// DEBUG INFO

// Get debug info as a JSON object for bug reporting and ad reporting
const getDebugInfo = function (callback) {
  const response = {};
  response.otherInfo = {};

  // Is this installed build of AdBlock the official one?
  if (chrome.runtime.id === 'pljaalgmajnlogcgiohkhdmgpomjcihk') {
    response.otherInfo.buildtype = ' Beta';
  } else if (chrome.runtime.id === 'gighmmpiobklfepjocnamgkkbiglidom'
            || chrome.runtime.id === 'aobdicepooefnbaeokijohmhjlleamfj') {
    response.otherInfo.buildtype = ' Stable';
  } else {
    response.otherInfo.buildtype = ' Unofficial';
  }

  // Get AdBlock version
  response.otherInfo.version = chrome.runtime.getManifest().version;

  // Get subscribed filter lists
  const subscriptionInfo = {};
  const subscriptions = getSubscriptionsMinusText();
  for (const id in subscriptions) {
    if (subscriptions[id].subscribed) {
      subscriptionInfo[id] = {};
      subscriptionInfo[id].lastSuccess = new Date(subscriptions[id].lastSuccess * 1000);
      subscriptionInfo[id].lastDownload = new Date(subscriptions[id].lastDownload * 1000);
      subscriptionInfo[id].downloadCount = subscriptions[id].downloadCount;
      subscriptionInfo[id].downloadStatus = subscriptions[id].downloadStatus;
    }
  }

  response.subscriptions = subscriptionInfo;

  const userFilters = getUserFilters();
  if (userFilters && userFilters.length) {
    response.customFilters = userFilters.join('\n');
  }

  // Get settings
  const adblockSettings = {};
  const settings = getSettings();
  for (const setting in settings) {
    adblockSettings[setting] = JSON.stringify(settings[setting]);
  }

  response.settings = adblockSettings;
  response.prefs = JSON.stringify(Prefs);
  response.otherInfo.browser = STATS.browser;
  response.otherInfo.browserVersion = STATS.browserVersion;
  response.otherInfo.osVersion = STATS.osVersion;
  response.otherInfo.os = STATS.os;
  if (window.blockCounts) {
    response.otherInfo.blockCounts = blockCounts.get();
  }
  if (localStorage
      && localStorage.length) {
    response.otherInfo.localStorageInfo = {};
    response.otherInfo.localStorageInfo.length = localStorage.length;
    let inx = 1;
    for (const key in localStorage) {
      response.otherInfo.localStorageInfo[`key${inx}`] = key;
      inx += 1;
    }
  } else {
    response.otherInfo.localStorageInfo = 'no data';
  }
  response.otherInfo.isAdblockPaused = adblockIsPaused();
  response.otherInfo.licenseState = License.get().status;
  response.otherInfo.licenseVersion = License.get().lv;

  // Get total pings
  chrome.storage.local.get('total_pings').then((storageResponse) => {
    response.otherInfo.totalPings = storageResponse.totalPings || 0;

    // Now, add exclude filters (if there are any)
    const excludeFiltersKey = 'exclude_filters';
    chrome.storage.local.get(excludeFiltersKey).then((secondResponse) => {
      if (secondResponse && secondResponse[excludeFiltersKey]) {
        response.excludedFilters = secondResponse[excludeFiltersKey];
      }
      // Now, add JavaScript exception error (if there is one)
      const errorKey = 'errorkey';
      chrome.storage.local.get(errorKey).then((errorResponse) => {
        if (errorResponse && errorResponse[errorKey]) {
          response.otherInfo[errorKey] = errorResponse[errorKey];
        }
        // Now, add the migration messages (if there are any)
        const migrateLogMessageKey = 'migrateLogMessageKey';
        chrome.storage.local.get(migrateLogMessageKey).then((migrateLogMessageResponse) => {
          if (migrateLogMessageResponse && migrateLogMessageResponse[migrateLogMessageKey]) {
            const messages = migrateLogMessageResponse[migrateLogMessageKey].split('\n');
            for (let i = 0; i < messages.length; i++) {
              const key = `migration_message_${i}`;
              response.otherInfo[key] = messages[i];
            }
          }
          if (License.isActiveLicense()) {
            response.otherInfo.licenseInfo = {};
            response.otherInfo.licenseInfo.extensionGUID = STATS.userId();
            response.otherInfo.licenseInfo.licenseId = License.get().licenseId;
            if (getSettings().sync_settings) {
              response.otherInfo.syncInfo = {};
              response.otherInfo.syncInfo.SyncCommitVersion = SyncService.getCommitVersion();
              response.otherInfo.syncInfo.SyncCommitName = SyncService.getCurrentExtensionName();
              response.otherInfo.syncInfo.SyncCommitLog = SyncService.getSyncLog();
            }
            chrome.alarms.getAll((alarms) => {
              if (alarms && alarms.length > 0) {
                response.otherInfo['Alarm info'] = `length: ${alarms.length}`;
                for (let i = 0; i < alarms.length; i++) {
                  const alarm = alarms[i];
                  response.otherInfo[`${i} Alarm Name`] = alarm.name;
                  response.otherInfo[`${i} Alarm Scheduled Time`] = new Date(alarm.scheduledTime);
                }
              } else {
                response.otherInfo['No alarm info'] = 'No alarm info';
              }
              License.getLicenseInstallationDate((installdate) => {
                response.otherInfo['License Installation Date'] = installdate;
                if (typeof callback === 'function') {
                  callback(response);
                }
              });
            });
          } else if (typeof callback === 'function') { // License is not active
            callback(response);
          }
        });
      });
    });
  });
};

// Called when user explicitly requests filter list updates
function updateFilterLists() {
  for (const subscription of filterStorage.subscriptions()) {
    if (subscription instanceof DownloadableSubscription) {
      synchronizer.execute(subscription, true, true);
    }
  }
}

// Checks if the filter lists are currently in the process of
// updating and if there were errors the last time they were
// updated
function checkUpdateProgress() {
  let inProgress = false;
  let filterError = false;
  for (const subscription of filterStorage.subscriptions()) {
    if (synchronizer.isExecuting(subscription.url)) {
      inProgress = true;
    } else if (subscription.downloadStatus && subscription.downloadStatus !== 'synchronize_ok') {
      filterError = true;
    }
  }
  return { inProgress, filterError };
}

STATS.untilLoaded(() => {
  STATS.startPinging();
  uninstallInit();
});

// Create the "blockage stats" for the uninstall logic ...
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.get('blockage_stats').then((response) => {
      const { blockage_stats } = response;
      if (!blockage_stats) {
        const data = {};
        data.start = Date.now();
        data.version = 1;
        chromeStorageSetHelper('blockage_stats', data);
      }
    });
  }
});

// AdBlock Protect integration
//
// Check the response from a ping to see if it contains valid show AdBlock Protect
// enrollment instructions. If so, set the "show_protect_enrollment" setting
// if an empty / zero length string is returned, and a user was previously enrolled then
// set "show_protect_enrollment" to false
// Inputs:
//   responseData: string response from a ping
function checkPingResponseForProtect(responseData) {
  let pingData;

  if (responseData.length === 0 || responseData.trim().length === 0) {
    if (getSettings().show_protect_enrollment) {
      setSetting('show_protect_enrollment', false);
    }
    return;
  }
  // if the user has clicked the Protect CTA, which sets the |show_protect_enrollment| to false
  // then don't re-enroll them, even if the ping server has a show_protect_enrollment = true.
  if (getSettings().show_protect_enrollment === false) {
    return;
  }
  try {
    pingData = JSON.parse(responseData);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Something went wrong with parsing survey data.');
    // eslint-disable-next-line no-console
    console.log('error', e);
    // eslint-disable-next-line no-console
    console.log('response data', responseData);
    return;
  }
  if (!pingData) {
    return;
  }
  if (typeof pingData.protect_enrollment === 'boolean') {
    setSetting('show_protect_enrollment', pingData.protect_enrollment);
  }
}

function isAcceptableAds(filterList) {
  if (!filterList) {
    return undefined;
  }
  return filterList.id === 'acceptable_ads';
}

function isAcceptableAdsPrivacy(filterList) {
  if (!filterList) {
    return undefined;
  }
  return filterList.id === 'acceptable_ads_privacy';
}

// Attach methods to window
Object.assign(window, {
  adblockIsPaused,
  createPageWhitelistFilter,
  getUserFilters,
  updateFilterLists,
  checkUpdateProgress,
  getDebugInfo,
  createWhitelistFilterForYoutubeChannel,
  openTab,
  readfile,
  saveDomainPauses,
  adblockIsDomainPaused,
  pageIsWhitelisted,
  pageIsUnblockable,
  getCurrentTabInfo,
  getAdblockUserId,
  tryToUnwhitelist,
  addCustomFilter,
  removeCustomFilter,
  countCache,
  updateCustomFilterCountMap,
  removeCustomFilterForHost,
  confirmRemovalOfCustomFiltersOnHost,
  reloadTab,
  isSelectorFilter,
  isWhitelistFilter,
  isSelectorExcludeFilter,
  addYouTubeHistoryStateUpdateHanlder,
  removeYouTubeHistoryStateUpdateHanlder,
  ytChannelNamePages,
  checkPingResponseForProtect,
  pausedFilterText1,
  pausedFilterText2,
  isLanguageSpecific,
  isAcceptableAds,
  isAcceptableAdsPrivacy,
  parseFilter,
});
