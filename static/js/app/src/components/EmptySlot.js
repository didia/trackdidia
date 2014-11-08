 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"user strict";

define(["react", "bootstrap"], function(React){
	var ReactPropTypes = React.PropTypes;
	var EmptySlotComponent = React.createClass({

		propTypes : {
			offset : ReactPropTypes.number.isRequired,
			duration: ReactPropTypes.number.isRequired

	    },
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {
			return (
				<div className = "row">
					I am an  empty Offset from {this.props.start} to {this.props.finish}
				</div>
				);
		}
	});

	return EmptySlotComponent;
})