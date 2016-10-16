import React from 'react';

let defaultStyles = {
    width: '100%',
    display: 'flex',
    padding: '3vh 3vw',
    alignItems: 'center',
    justifyContent: 'center'
};
const Home = () => {
    return (
        <div className="Home" style={defaultStyles}>
            Home of the future Trackdidia App!
        </div>
    )
}
export default Home;
