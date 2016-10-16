import React, { Component } from 'react';
import MuiThemeProvider from 'material-ui/styles/MuiThemeProvider'
import AppBar from 'material-ui/AppBar'
import NavLink from '../shared/NavLink'

let defaultStyles = {
    navLink: {
        textDecoration: 'none',
        color: 'inherit'
    }
}

class App extends Component {
    render() {
        return (
            <MuiThemeProvider>
                <div className="trackdidia">
                    <AppBar title={<NavLink to="/" onlyActiveOnIndex style={defaultStyles.navLink}>Life Dashboard</NavLink>} className="app-bar" />
                    <div className="page-content">
                        {this.props.children}
                    </div>
                </div>
            </MuiThemeProvider>
        );
    }
}

export default App;
