import React, { useEffect } from 'react'
import Sidebar from './components/Sidebar.jsx'
import { TopBar, StatusBar } from './components/TopBar.jsx'
import { UIProvider } from './components/UIContext.jsx'
import ModelPage from './pages/ModelPage.jsx'
import AvatarPage from './pages/AvatarPage.jsx'
import VoicePage from './pages/VoicePage.jsx'
import PersonaPage from './pages/PersonaPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import PublishPage from './pages/PublishPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import { store } from './store/store.js'

const VALID_PAGES = ['model', 'avatar', 'voice', 'persona', 'chat', 'publish', 'settings']

function readHash() {
  const h = window.location.hash.replace('#', '')
  return VALID_PAGES.includes(h) ? h : 'model'
}

function Console() {
  const [page, setPageState] = React.useState(readHash)

  const setPage = (p) => {
    setPageState(p)
    window.location.hash = p
  }

  // 顶栏"去发布"按钮 + 浏览器前进/后退：跨组件跳转与 hash 同步
  useEffect(() => {
    const handler = () => setPage('publish')
    const hashHandler = () => setPageState(readHash())
    window.addEventListener('navigate-publish', handler)
    window.addEventListener('hashchange', hashHandler)
    return () => {
      window.removeEventListener('navigate-publish', handler)
      window.removeEventListener('hashchange', hashHandler)
    }
  }, [])

  const gotoPublish = () => setPage('publish')

  const pages = {
    model: <ModelPage />,
    avatar: <AvatarPage />,
    voice: <VoicePage />,
    persona: <PersonaPage />,
    chat: <ChatPage />,
    publish: <PublishPage />,
    settings: <SettingsPage />,
  }

  return (
    <div className="app">
      <Sidebar page={page} setPage={setPage} />
      <div className="main">
        <TopBar page={page} onGotoPublish={gotoPublish} />
        <main className="content">{pages[page]}</main>
        <StatusBar />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <UIProvider>
      <Console />
    </UIProvider>
  )
}
