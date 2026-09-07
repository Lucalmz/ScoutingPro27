import { ref, computed, nextTick, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { useEventStore } from '@/stores/events'
import { useNavigationStore, type EventTab, type EventNavigationState } from '@/stores/navigation'

export interface EventTransitionsOptions {
  route: RouteLocationNormalizedLoaded
  router: Router
  eventId: Ref<string>
  contentRef: Ref<HTMLElement | null>
  t: (key: string, values?: Record<string, any>) => string
}

export function useEventTransitions({
  route,
  router,
  eventId,
  contentRef,
  t
}: EventTransitionsOptions) {
  const eventStore = useEventStore()
  const navStore = useNavigationStore()

  function getInitialTab(): EventTab {
    const id = (route.params.eventId as string) || ''
    const saved = id ? navStore.getEventPosition(id) : null
    if (saved?.fromTab) {
      return saved.fromTab
    }
    const tabQuery = route.query.tab as string
    if (tabQuery && ['scout', 'pit', 'schedule', 'rankings', 'history', 'scouts', 'ai'].includes(tabQuery)) {
      return tabQuery as EventTab
    }
    return 'scout'
  }

  const activeTab = ref<EventTab>(getInitialTab())

  const tabs = computed(() => {
    const baseTabs: Array<{ key: EventTab; label: string }> = [
      { key: 'scout' as const, label: t('event.tab_scout') },
      { key: 'pit' as const, label: t('event.tab_pit') },
      { key: 'schedule' as const, label: t('event.tab_schedule') },
      { key: 'rankings' as const, label: t('event.tab_rankings') },
      { key: 'history' as const, label: t('event.tab_history') },
      { key: 'ai' as const, label: t('event.tab_ai') }
    ]
    if (eventStore.isHost) {
      baseTabs.push({ key: 'scouts' as const, label: t('event.tab_scouts') })
    }
    return baseTabs
  })

  let currentTabTransition: any = null

  function switchTab(newTabKey: EventTab) {
    if (activeTab.value === newTabKey) return

    router.replace({
      query: {
        ...route.query,
        tab: newTabKey
      }
    })

    if (eventId.value) {
      const tabContent = contentRef.value
      const chatMessages = document.querySelector('.chat-messages') as HTMLElement | null
      const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
      navStore.saveEventPosition({
        eventId: eventId.value,
        fromTab: newTabKey,
        contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
        contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
        tableScrollLeft: tableWrapper ? tableWrapper.scrollLeft : 0,
        aiChatScrollTop: chatMessages ? chatMessages.scrollTop : null,
        teamNumber: null
      })
    }

    if (!document.startViewTransition) {
      activeTab.value = newTabKey
      return
    }

    if (currentTabTransition) {
      currentTabTransition.skipTransition()
    }

    const currentIndex = tabs.value.findIndex((t) => t.key === activeTab.value)
    const newIndex = tabs.value.findIndex((t) => t.key === newTabKey)
    const direction = newIndex > currentIndex ? 'slide-left' : 'slide-right'

    document.documentElement.dataset.transitionType = 'tab-switch'
    document.documentElement.dataset.tabDirection = direction
    document.documentElement.removeAttribute('data-direction')

    try {
      currentTabTransition = document.startViewTransition(() => {
        activeTab.value = newTabKey
        return nextTick()
      })

      currentTabTransition.finished.finally(() => {
        currentTabTransition = null
        document.documentElement.removeAttribute('data-transition-type')
        document.documentElement.removeAttribute('data-tab-direction')
      })
    } catch {
      activeTab.value = newTabKey
      document.documentElement.removeAttribute('data-transition-type')
      document.documentElement.removeAttribute('data-tab-direction')
    }
  }

  function restorePosition(savedPos: EventNavigationState) {
    activeTab.value = savedPos.fromTab
    nextTick(() => {
      setTimeout(() => {
        if (contentRef.value && savedPos.contentScrollTop) {
          contentRef.value.scrollTop = savedPos.contentScrollTop
        }
        if (savedPos.fromTab === 'rankings') {
          const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
          if (tableWrapper && savedPos.tableScrollLeft) {
            tableWrapper.scrollLeft = savedPos.tableScrollLeft
          }
          if (savedPos.teamNumber) {
            const targetRow = document.querySelector(`[data-team-row="${savedPos.teamNumber}"]`) as HTMLElement | null
            if (targetRow && !savedPos.contentScrollTop) {
              targetRow.scrollIntoView({ block: 'center' })
            }
          }
        }
      }, 20)
    })
  }

  function saveLeavePosition(toTeamNumber?: number | null) {
    const tabContent = contentRef.value
    const chatMessages = document.querySelector('.chat-messages') as HTMLElement | null
    const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
    navStore.saveEventPosition({
      eventId: eventId.value,
      fromTab: activeTab.value,
      contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
      contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
      tableScrollLeft: tableWrapper ? tableWrapper.scrollLeft : 0,
      aiChatScrollTop: chatMessages ? chatMessages.scrollTop : null,
      teamNumber: toTeamNumber ? Number(toTeamNumber) : null
    })
  }

  return {
    activeTab,
    tabs,
    switchTab,
    restorePosition,
    saveLeavePosition
  }
}
