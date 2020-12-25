import { useState, useEffect, useMemo, useCallback } from 'react'
import { parseTokenFromLocation } from './parseTokenFromLocation'

const GO_TRUE_TOKEN_STORAGE_KEY = 'ni.goTrueToken'
const USER_STORAGE_KEY = 'ni.user'
const FOUR_MINUTES = 1000 * 60 * 4

// Api docs to come
const useNetlifyIdentity = ({ url: _url }) => {

  // Contains the user details section of things
  const [user, setUser] = useState()

  // Contains the actual GoTrue token { access_token:, refresh_token:, expires_at: }
  const [goTrueToken, _setGoTrueToken] = useState()

  // Contains the netlify email-token after it's snagged from the URL path hash
  const [urlToken, setUrlToken] = useState()

  // Contains arguments to send an update to the user info with (for two-step invite flow)
  const [pendingUpdateArgs, setPendingUpdateArgs] = useState()

  // Contains the information for the user (not persisted) - they need to confirm email
  const [provisionalUser, setProvisionalUser] = useState()

  // Contains the ID of the timeout set to refresh the goTrueToken so that we can
  // prevent race conditions between updates (which refresh the token) and timer-
  // based refreshes. Yay!
  const [goTrueTokenRefreshTimeoutId, setGoTrueTokenRefreshTimeoutId] = useState()

  // A flag for refreshing the goTrueToken - it's only used following an .update(), which
  // sets the user, so there's no need to set the user too 
  const [pendingGoTrueTokenRefresh, setPendingGoTrueTokenRefresh] = useState()

  // Memoize the url to prevent useEffect changes since it won't change 
  const url = useMemo(() => `${_url}/.netlify/identity`, [_url])


  // NOTE: The one trick at play here is for forcing a user refresh. It actually
  // just runs a blank .update() (to which GoTrue returns the current user data),
  // then update sets the user and queues a goTrueToken update, which effect-runs.


  // API: Thin fetch wrapper for Authenticated Functions
  const authorizedFetch = useCallback(async (url, options) => {
    if (!goTrueToken) throw new Error('Cannot authorizedFetch while logged out')

    return fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        'Authorization': `Bearer ${goTrueToken.access_token}`
      },
    })
  }, [goTrueToken])

  // Thin wrapper around useState setter to inject expires_at
  const setGoTrueToken = useCallback(goTrueToken => {
    const expires_at = new Date(JSON.parse(urlBase64Decode(goTrueToken.access_token.split('.')[1])).exp * 1000)
    _setGoTrueToken({ ...goTrueToken, expires_at })
  }, [])

  // STUB - Exclusively refreshes the goTrueToken (doesn't touch user) -- 
  // doesn't check any expirations or anything, just goes ahead and refreshes
  const refreshGoTrueToken = useCallback(async () => {
    setGoTrueToken(await fetch(`${url}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=refresh_token&refresh_token=${goTrueToken.refresh_token}`,
    }).then(resp => resp.json()))
  }, [setGoTrueToken, url, goTrueToken])

  // API: Log out current user
  const logout = useCallback(async () => {
    localStorage.removeItem(GO_TRUE_TOKEN_STORAGE_KEY)
    localStorage.removeItem(USER_STORAGE_KEY)
    _setGoTrueToken()
    setUser()
    if (goTrueTokenRefreshTimeoutId) clearTimeout(goTrueTokenRefreshTimeoutId)
  }, [goTrueTokenRefreshTimeoutId])

  // Any time the goTrueToken changes, make sure it gets saved down to local
  // storage then setup a timeout that will run 4 minutes before it expires (or
  // now if that's sooner / expired already) to refresh it
  useEffect(() => {
    if (goTrueToken) {
      localStorage.setItem(GO_TRUE_TOKEN_STORAGE_KEY, JSON.stringify(goTrueToken))

      const timeToRefresh = Math.max((new Date(goTrueToken.expires_at)).getTime() - (new Date()).getTime() - FOUR_MINUTES, 0)
      console.log(`Refresh goTrueToken in ${(timeToRefresh / 1000).toFixed(0)} seconds`)

      setGoTrueTokenRefreshTimeoutId(setTimeout(
        refreshGoTrueToken,
        timeToRefresh
      ))
    }

  }, [goTrueToken, refreshGoTrueToken])

  // Similarly, always make sure User is stored down to local storage
  useEffect(() => {
    if (user) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    }
  }, [user])

  // Loads user and goTrueToken from LocalStorage on page load
  useEffect(() => {
    const goTrueTokenString = localStorage.getItem(GO_TRUE_TOKEN_STORAGE_KEY)
    const userString = localStorage.getItem(USER_STORAGE_KEY)
    if (goTrueTokenString && userString) {
      _setGoTrueToken(JSON.parse(goTrueTokenString))
      setUser(JSON.parse(userString))
      setProvisionalUser()
    }
  }, [])

  // Grab the urlToken from location if exists
  useEffect(() => {
    setUrlToken(parseTokenFromLocation())
  }, [])

  // urlToken-dependent only
  useEffect(() => {
    if (urlToken) {
      switch (urlToken.type) {
        case 'confirmation':
          // TODO: Handle failure case (clicked again)
          console.log('Confirming User')
          fetch(`${url}/verify`, {
            method: 'POST',
            body: JSON.stringify({
              token: urlToken.token,
              type: 'signup'
            })
          })
            .then(resp => resp.json())
            .then(token => {
              // Confirmation email clicked second time+
              if (token.code === "404") {
                logout()
                throw new Error('Confirmation already used')
              }
              setGoTrueToken(token)
            })
            .then(() => {
              setUrlToken()
            })
          break
        case 'recovery':
          console.log('Recovering User')
          fetch(`${url}/verify`, {
            method: 'POST',
            body: JSON.stringify({
              token: urlToken.token,
              type: 'recovery'
            })
          })
            .then(resp => resp.json())
            .then(setGoTrueToken)
          // Explicitly not setting the urlToken to null so that a password
          // reset can occur (this just logs the user in first)
          break
        default:
          return
      }
    }

  }, [urlToken, url, setGoTrueToken, logout])

  // API: The handler for urlTokens which require the user to set a password in
  // addition to the urlToken
  const completeUrlTokenTwoStep = async ({ password, ...rest }) => {
    if (urlToken?.type === 'recovery') {
      console.log('Updating Password & Clearing URL Token')
      setPendingUpdateArgs({ password })
      setUrlToken()
    }
    else if (urlToken?.type === 'invite') {
      console.log('Setting Up Invited User')
      // Initial POST only sets the password
      const token = await fetch(`${url}/verify`, {
        method: 'POST',
        body: JSON.stringify({
          token: urlToken.token,
          type: 'signup',
          password,
        })
      }).then(resp => resp.json())
      setGoTrueToken(token)
      setPendingUpdateArgs(rest)
      setUrlToken()
    }
  }

  // API: Log in user
  const login = async ({ email, password }) => {
    const token = await fetch(`${url}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=password&username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
    }).then(resp => resp.json())
    if (token?.error_description) {
      throw new Error(token.error_description)
    }
    setGoTrueToken(token)
  }

  // API: Sign up as a new user - email, password, data: { full_name: }, etc.
  // Sets the provisional user for visibility's sake
  const signup = async (props) => {
    const user = await fetch(`${url}/signup`, {
      method: 'POST',
      body: JSON.stringify(props)
    }).then(resp => resp.json())
    setProvisionalUser(user)
  }

  // API: Update user info - update({ email, password, user_metadata: { full_name: } }), etc.
  const update = useCallback(async props => {
    // Rename props.user_metadata to props.data per GoTrue's (odd) spec
    delete Object.assign(props, { ['data']: props['user_metadata'] })['user_metadata']; // eslint-disable-line

    const user = await authorizedFetch(`${url}/user`, {
      method: 'PUT',
      body: JSON.stringify(props)
    }).then(resp => resp.json())

    // Set the user then refresh the token so JWT-user gets refreshed
    setUser(user)
    setPendingGoTrueTokenRefresh(true)
  }, [url, authorizedFetch, setUser, setPendingGoTrueTokenRefresh])

  // Async update - mostly applies for the invite-token workflow when saving
  // more data on a new account than just the password
  useEffect(() => {
    if (goTrueToken && user && pendingUpdateArgs) {
      setPendingUpdateArgs()
      update(pendingUpdateArgs)
    }
  }, [goTrueToken, user, pendingUpdateArgs, update])

  // Token and User dependent since user needs to be logged in to run email_change
  useEffect(() => {
    if (urlToken && urlToken.type === 'email_change' && user) {
      console.log('Confirming Email Change')
      setPendingUpdateArgs({ email_change_token: urlToken.token })
      setUrlToken()
    }
  }, [urlToken, user, update])

  // Set the token when logging in; effect will grab user details
  useEffect(() => {
    if (goTrueToken && !user) {
      authorizedFetch(`${url}/user`)
        .then(resp => resp.json())
        .then(user => setUser(user))
    }
  }, [url, goTrueToken, user, authorizedFetch, setUser])

  // API: Requests a password recovery email for the specified email-user
  const sendPasswordRecovery = async ({ email }) => {
    return fetch(`${url}/recover`, {
      method: 'POST',
      body: JSON.stringify({ email })
    })
  }

  // Catches the pendingTokenRefresh flag and runs the token refresh function
  useEffect(() => {
    if (goTrueToken && pendingGoTrueTokenRefresh) {
      clearTimeout(goTrueTokenRefreshTimeoutId)
      refreshGoTrueToken()
      setPendingGoTrueTokenRefresh()
    }
  }, [goTrueToken, pendingGoTrueTokenRefresh, refreshGoTrueToken, goTrueTokenRefreshTimeoutId])

  return {
    user,
    login,
    logout,
    update,
    signup,
    urlToken,
    refreshUser: update,
    authorizedFetch,
    provisionalUser,
    sendPasswordRecovery,
    completeUrlTokenTwoStep,
  }
}

function urlBase64Decode(str) {
  // From https://jwt.io/js/jwt.js
  var output = str.replace(/-/g, '+').replace(/_/g, '/');
  let cleaned
  switch (output.length % 4) {
    case 0:
      cleaned = output
    case 2:
      cleaned = `${output}==`
      break;
    case 3:
      cleaned = `${output}=`
      break;
    default:
      throw new Error('Illegal base64url string!')
  }
  var result = window.atob(cleaned); //polifyll https://github.com/davidchambers/Base64.js
  try {
    return decodeURIComponent(escape(result));
  } catch (err) {
    return result;
  }
}

export {
  useNetlifyIdentity
}
