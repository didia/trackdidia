 /** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"user strict";

define(["react"], function(React){

	var EmptySlotComponent = React.createClass({
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {
			return (
				<div>
				</div>
				);
		}
	});

	return EmptySlotComponent;
})